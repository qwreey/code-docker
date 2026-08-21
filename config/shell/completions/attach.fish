# Completion for `attach` (bin/attach -> `webmanager --attach`, see that
# script's and webmanager/backend/attachcmd.go's doc comments).
#
# Session-name candidates are fetched by shelling out to
# `webmanager --list-sessions` (webmanager/backend/listsessionscmd.go)
# rather than talking to the HTTP API directly from fish, so the
# auth-gate/graceful-degrade logic (silently offers nothing if the password
# gate is on, webmanager isn't reachable, etc.) lives in one place instead
# of being reimplemented per shell. This is only a suggestion list, not a
# restriction - `attach <name>` creates a brand-new session for any name
# that doesn't already exist, so free text typed past these candidates must
# stay valid.
function __attach_list_sessions
    /etc/code-docker/webmanager/webmanager --list-sessions 2>/dev/null
end

complete -c attach -f
complete -c attach -n '__fish_is_nth_token 1' -a '(__attach_list_sessions)' -d 'session'
complete -c attach -n '__fish_is_nth_token 2' -a '(__fish_complete_directories)' -d 'start dir'
