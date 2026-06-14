#!/bin/sh
# quilx agent-status reporter — invoked by Claude Code hooks (see AgentTerminal).
#
# Writes a one-word status (idle|working|waiting) to $QUILX_STATUS_FILE, which the
# editor watches via a Gio file monitor. argv[1] is the status to write, except
# "notification" which is derived from the Notification payload's type (read from
# stdin). The write is atomic (tmp + rename) so the monitor sees one clean change.
[ -n "$QUILX_STATUS_FILE" ] || exit 0

status="$1"
if [ "$status" = "notification" ]; then
  payload=$(cat)
  case "$payload" in
    *'"permission_prompt"'* | *'"elicitation'*) status=waiting ;;
    *'"idle_prompt"'*) status=idle ;;
    *) exit 0 ;; # other notifications carry no status — ignore
  esac
fi

printf '%s' "$status" > "$QUILX_STATUS_FILE.tmp" 2>/dev/null && mv "$QUILX_STATUS_FILE.tmp" "$QUILX_STATUS_FILE" 2>/dev/null
exit 0
