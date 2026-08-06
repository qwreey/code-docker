package supervisor

import (
	"encoding/xml"
	"strconv"
	"strings"
)

// rpcValue models the union type of an XML-RPC <value> element. A value
// with no recognized type child (plain chardata) is implicitly a string,
// per the XML-RPC spec.
type rpcValue struct {
	String   *string    `xml:"string"`
	Int      *string    `xml:"int"`
	I4       *string    `xml:"i4"`
	Boolean  *string    `xml:"boolean"`
	Array    *rpcArray  `xml:"array"`
	Struct   *rpcStruct `xml:"struct"`
	Chardata string     `xml:",chardata"`
}

type rpcArray struct {
	Values []rpcValue `xml:"data>value"`
}

type rpcMember struct {
	Name  string   `xml:"name"`
	Value rpcValue `xml:"value"`
}

type rpcStruct struct {
	Members []rpcMember `xml:"member"`
}

type methodResponse struct {
	XMLName xml.Name `xml:"methodResponse"`
	Params  *struct {
		Param []struct {
			Value rpcValue `xml:"value"`
		} `xml:"param"`
	} `xml:"params"`
	Fault *struct {
		Value rpcValue `xml:"value"`
	} `xml:"fault"`
}

func (v rpcValue) asString() string {
	if v.String != nil {
		return *v.String
	}
	return strings.TrimSpace(v.Chardata)
}

func (v rpcValue) asInt() (int64, error) {
	s := strings.TrimSpace(v.Chardata)
	switch {
	case v.Int != nil:
		s = *v.Int
	case v.I4 != nil:
		s = *v.I4
	}
	return strconv.ParseInt(strings.TrimSpace(s), 10, 64)
}

func (v rpcValue) asStruct() map[string]rpcValue {
	m := make(map[string]rpcValue)
	if v.Struct == nil {
		return m
	}
	for _, mem := range v.Struct.Members {
		m[mem.Name] = mem.Value
	}
	return m
}

func (v rpcValue) asArray() []rpcValue {
	if v.Array == nil {
		return nil
	}
	return v.Array.Values
}
