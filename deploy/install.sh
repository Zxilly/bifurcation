# Bifurcation installer. Source this file, then call bifurcation_install.
# No commands run until the function is called.
bifurcation_install() (
  set +x
  set -eu
  umask 077
  panel=''
  token=''
  take_over=0
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --panel) [ "$#" -ge 2 ] || { printf '%s\n' 'Missing --panel value' >&2; exit 2; }; panel=$2; shift 2 ;;
      --token) [ "$#" -ge 2 ] || { printf '%s\n' 'Missing --token value' >&2; exit 2; }; token=$2; shift 2 ;;
      --take-over) take_over=1; shift ;;
      *) printf 'Unknown option: %s\n' "$1" >&2; exit 2 ;;
    esac
  done
  [ "$(id -u)" = 0 ] || { printf '%s\n' 'Run the installer as root.' >&2; exit 1; }
  [ "$(uname -s)" = Linux ] || { printf '%s\n' 'Only Linux is supported.' >&2; exit 1; }
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) printf '%s\n' 'Unsupported architecture.' >&2; exit 1 ;; esac
  for tool in curl sha256sum systemctl install mktemp cp mv chmod grep; do
    command -v "$tool" >/dev/null 2>&1 || { printf 'Required command is missing: %s\n' "$tool" >&2; exit 1; }
  done
  [ -d /run/systemd/system ] || { printf '%s\n' 'A running systemd host is required.' >&2; exit 1; }
  panel=${panel%/}
  case "$panel" in
    https://*) curl_protocol='=https' ;;
    http://localhost|http://localhost:*|http://127.0.0.1|http://127.0.0.1:*) curl_protocol='=http,https' ;;
    *) printf '%s\n' 'Use an HTTPS panel origin (HTTP is allowed only on localhost).' >&2; exit 2 ;;
  esac
  # Restrict the input before it becomes a URL; the daemon additionally validates the origin.
  case "$panel" in *'?'*|*'#'*|*'@'*|*[[:space:]]*|*'\'*) printf '%s\n' 'Invalid panel origin.' >&2; exit 2 ;; esac
  authority=${panel#*://}
  case "$authority" in */*) printf '%s\n' 'The panel URL must not contain a path.' >&2; exit 2 ;; esac
  case "$token" in bm_*) ;; *) printf '%s\n' 'Invalid machine token.' >&2; exit 2 ;; esac
  [ "${#token}" = 46 ] || { printf '%s\n' 'Invalid machine token length.' >&2; exit 2; }
  case "$token" in *[!A-Za-z0-9_-]*) printf '%s\n' 'Invalid machine token.' >&2; exit 2 ;; esac

  binary=/usr/local/bin/bifurcation-daemon
  recovery=/usr/local/libexec/bifurcation-recovery
  config=/etc/bifurcation/daemon.json
  state=/var/lib/bifurcation
  unit=/etc/systemd/system/bifurcation-daemon.service
  for path in "$binary" "$recovery" "$config" "$state" "$unit" /etc/bifurcation /usr/local/libexec; do
    [ ! -L "$path" ] || { printf 'Refusing symbolic link: %s\n' "$path" >&2; exit 1; }
  done
  if [ -e "$unit" ] && ! grep -q '^# Managed by Bifurcation installer v1$' "$unit" && [ "$take_over" = 0 ]; then
    printf '%s\n' 'An existing service is not managed by this installer. Review it and use --take-over explicitly.' >&2; exit 1
  fi
  if [ -e "$binary" ] && [ ! -e "$unit" ] && [ "$take_over" = 0 ]; then
    printf '%s\n' 'An unmanaged binary exists. Review it and use --take-over explicitly.' >&2; exit 1
  fi
  work=$(mktemp -d /tmp/bifurcation-install.XXXXXXXX) || exit 1
  case "$work" in /tmp/bifurcation-install.*) ;; *) printf '%s\n' 'Invalid temporary directory.' >&2; exit 1 ;; esac
  trap 'rm -rf -- "$work"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  artifact="daemon-linux-$arch"
  curl --fail --silent --show-error --location --proto "$curl_protocol" --proto-redir "$curl_protocol" --connect-timeout 15 --max-time 300 "$panel/artifacts/$artifact" -o "$work/daemon" || exit 1
  curl --fail --silent --show-error --location --proto "$curl_protocol" --proto-redir "$curl_protocol" --connect-timeout 15 --max-time 30 "$panel/artifacts/$artifact.sha256" -o "$work/checksum" || exit 1
  # Parse only a conventional single sha256sum line; never interpret the downloaded filename as a path.
  IFS=' ' read -r expected checksum_name < "$work/checksum" || { printf '%s\n' 'Invalid checksum file.' >&2; exit 1; }
  [ "${#expected}" = 64 ] || { printf '%s\n' 'Invalid SHA-256.' >&2; exit 1; }
  case "$expected" in *[!a-fA-F0-9]*) printf '%s\n' 'Invalid SHA-256.' >&2; exit 1 ;; esac
  printf '%s  %s\n' "$expected" "$work/daemon" | sha256sum --check --status - || { printf '%s\n' 'SHA-256 verification failed; installation stopped.' >&2; exit 1; }
  chmod 700 "$work/daemon" || exit 1
  downloaded_version=$("$work/daemon" -version) || exit 1
  printf 'Downloaded daemon version: %s\n' "$downloaded_version"
  "$work/daemon" -capabilities > "$work/capabilities" || exit 1

  backup=''
  if [ -e "$binary" ] || [ -e "$config" ] || [ -e "$unit" ]; then
    [ ! -L /var/backups/bifurcation ] || { printf '%s\n' 'Refusing symbolic backup directory.' >&2; exit 1; }
    install -d -m 700 /var/backups/bifurcation || exit 1
    backup=$(mktemp -d /var/backups/bifurcation/install.XXXXXXXX) || exit 1
    [ ! -e "$binary" ] || cp -p -- "$binary" "$backup/daemon" || exit 1
    [ ! -e "$config" ] || cp -p -- "$config" "$backup/daemon.json" || exit 1
    [ ! -e "$unit" ] || cp -p -- "$unit" "$backup/bifurcation-daemon.service" || exit 1
    printf 'Previous installation backed up to %s\n' "$backup"
  fi
  install -d -m 700 /etc/bifurcation "$state" || exit 1
  if [ "$take_over" = 1 ]; then
    printf '%s\n' "$token" | "$work/daemon" -configure -replace-config -panel "$panel" -state-directory "$state" -config "$config" || exit 1
  else
    printf '%s\n' "$token" | "$work/daemon" -configure -panel "$panel" -state-directory "$state" -config "$config" || exit 1
  fi
  token=''
  # Check the rollback contract before opening the existing database.
  if [ -e "$recovery" ]; then "$work/daemon" -verify-recovery "$recovery" || exit 1; fi
  # Check configuration and migrations before replacing the installed binary.
  "$work/daemon" -config "$config" -check || exit 1
  # Keep recovery independent of the executable replaced by self-updates.
  install -d -m 755 /usr/local/libexec || exit 1
  if [ ! -e "$recovery" ]; then
    staged_recovery=$(mktemp /usr/local/libexec/.bifurcation-recovery.XXXXXXXX) || exit 1
    install -m 755 "$work/daemon" "$staged_recovery" || { rm -f -- "$staged_recovery"; exit 1; }
    mv -f -- "$staged_recovery" "$recovery" || { rm -f -- "$staged_recovery"; exit 1; }
  fi
  "$recovery" -capabilities > "$work/recovery-capabilities" || exit 1
  staged_binary=$(mktemp /usr/local/bin/.bifurcation-daemon.XXXXXXXX) || exit 1
  install -m 755 "$work/daemon" "$staged_binary" || { rm -f -- "$staged_binary"; exit 1; }
  mv -f -- "$staged_binary" "$binary" || { rm -f -- "$staged_binary"; exit 1; }
  cat > "$work/unit" <<'BIFURCATION_UNIT' || exit 1
# Managed by Bifurcation installer v1
[Unit]
Description=Bifurcation node daemon
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStartPre=/usr/local/libexec/bifurcation-recovery -recover-update -config /etc/bifurcation/daemon.json
ExecStart=/usr/local/bin/bifurcation-daemon -config /etc/bifurcation/daemon.json
Restart=on-failure
RestartSec=5
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
BIFURCATION_UNIT
  staged_unit=$(mktemp /etc/systemd/system/.bifurcation-daemon.XXXXXXXX) || exit 1
  install -m 644 "$work/unit" "$staged_unit" || { rm -f -- "$staged_unit"; exit 1; }
  mv -f -- "$staged_unit" "$unit" || { rm -f -- "$staged_unit"; exit 1; }
  systemctl daemon-reload || exit 1
  systemctl enable bifurcation-daemon.service || exit 1
  systemctl restart bifurcation-daemon.service || exit 1
  systemctl is-active --quiet bifurcation-daemon.service || {
    printf '%s\n' 'The daemon service is not active. Inspect journalctl -u bifurcation-daemon.service.' >&2
    [ -z "$backup" ] || printf 'Previous files remain at %s; persistent node state was retained.\n' "$backup" >&2
    exit 1
  }
  installed_version=$("$binary" -version) || exit 1
  printf 'Installed daemon version: %s\n' "$installed_version"
  printf '%s\n' 'The local daemon service is active. Confirm enrollment and connection status in the panel.'
)
