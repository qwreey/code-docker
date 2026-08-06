// Package supervisor is a minimal XML-RPC client for supervisord's
// unix-socket RPC interface (http://supervisord.org/api.html). Only the
// method shapes router-manager actually needs are implemented — no generic
// XML-RPC marshaling is attempted.
//
// Ported unchanged from webmanager/backend/internal/supervisor (see
// router/plan.md's TODO list) — router's own supervisord exposes the same
// /run/supervisor.sock unix_http_server (router/config/netgate/
// supervisord.default.conf), so no adaptation was needed.
package supervisor

import (
	"context"
	"encoding/xml"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
)

type Client struct {
	http *http.Client
}

func NewClient(sockPath string) *Client {
	return &Client{
		http: &http.Client{
			Transport: &http.Transport{
				DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
					var d net.Dialer
					return d.DialContext(ctx, "unix", sockPath)
				},
			},
		},
	}
}

// Fault represents an XML-RPC <fault> response. Fault codes are supervisord's
// own (see supervisor/xmlrpc.py Faults), notably BAD_NAME=10, ALREADY_STARTED=60,
// NOT_RUNNING=70 — callers use these to decide HTTP status mapping.
type Fault struct {
	Code    int
	Message string
}

func (f *Fault) Error() string {
	return fmt.Sprintf("supervisor fault %d: %s", f.Code, f.Message)
}

type ProcessInfo struct {
	Name        string `json:"name"`
	Group       string `json:"group"`
	Statename   string `json:"statename"`
	Description string `json:"description"`
	Pid         int64  `json:"pid"`
	Start       int64  `json:"start"`
	Now         int64  `json:"now"`
}

func (c *Client) GetAllProcessInfo(ctx context.Context) ([]ProcessInfo, error) {
	v, err := c.call(ctx, "supervisor.getAllProcessInfo")
	if err != nil {
		return nil, err
	}
	items := v.asArray()
	out := make([]ProcessInfo, 0, len(items))
	for _, item := range items {
		s := item.asStruct()
		pid, _ := s["pid"].asInt()
		start, _ := s["start"].asInt()
		now, _ := s["now"].asInt()
		out = append(out, ProcessInfo{
			Name:        s["name"].asString(),
			Group:       s["group"].asString(),
			Statename:   s["statename"].asString(),
			Description: s["description"].asString(),
			Pid:         pid,
			Start:       start,
			Now:         now,
		})
	}
	return out, nil
}

func (c *Client) StartProcess(ctx context.Context, name string) error {
	_, err := c.call(ctx, "supervisor.startProcess", stringParam(name))
	return err
}

func (c *Client) StopProcess(ctx context.Context, name string) error {
	_, err := c.call(ctx, "supervisor.stopProcess", stringParam(name))
	return err
}

func (c *Client) ReadProcessStdoutLog(ctx context.Context, name string, offset, length int) (string, error) {
	return c.readLog(ctx, "supervisor.readProcessStdoutLog", name, offset, length)
}

func (c *Client) ReadProcessStderrLog(ctx context.Context, name string, offset, length int) (string, error) {
	return c.readLog(ctx, "supervisor.readProcessStderrLog", name, offset, length)
}

func (c *Client) readLog(ctx context.Context, method, name string, offset, length int) (string, error) {
	v, err := c.call(ctx, method, stringParam(name), intParam(offset), intParam(length))
	if err != nil {
		return "", err
	}
	return v.asString(), nil
}

func stringParam(s string) string {
	var buf strings.Builder
	_ = xml.EscapeText(&buf, []byte(s))
	return "<param><value><string>" + buf.String() + "</string></value></param>"
}

func intParam(i int) string {
	return "<param><value><int>" + strconv.Itoa(i) + "</int></value></param>"
}

func (c *Client) call(ctx context.Context, method string, params ...string) (rpcValue, error) {
	body := `<?xml version="1.0"?><methodCall><methodName>` + method +
		`</methodName><params>` + strings.Join(params, "") + `</params></methodCall>`

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://unix/RPC2", strings.NewReader(body))
	if err != nil {
		return rpcValue{}, err
	}
	req.Header.Set("Content-Type", "text/xml")

	resp, err := c.http.Do(req)
	if err != nil {
		return rpcValue{}, fmt.Errorf("supervisor rpc %s: %w", method, err)
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return rpcValue{}, fmt.Errorf("supervisor rpc %s: read response: %w", method, err)
	}

	var mr methodResponse
	if err := xml.Unmarshal(data, &mr); err != nil {
		return rpcValue{}, fmt.Errorf("supervisor rpc %s: decode response: %w", method, err)
	}

	if mr.Fault != nil {
		fs := mr.Fault.Value.asStruct()
		code, _ := fs["faultCode"].asInt()
		return rpcValue{}, &Fault{Code: int(code), Message: fs["faultString"].asString()}
	}
	if mr.Params == nil || len(mr.Params.Param) == 0 {
		return rpcValue{}, nil
	}
	return mr.Params.Param[0].Value, nil
}
