#!/bin/sh
# Run only in a disposable Linux container; this intentionally uses container /etc and /var.
set -eu
[ "${BIFURCATION_DISPOSABLE_TEST_CONTAINER:-}" = 1 ] || { echo 'Use the documented disposable container runner.' >&2; exit 1; }
[ -f /.dockerenv ] || { echo 'This test requires Docker isolation.' >&2; exit 1; }
mkdir -p /fakebin /run/systemd/system /fixtures /usr/local/bin
cat > /fakebin/curl <<'MOCK_CURL'
#!/bin/sh
set -eu
destination=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) destination=$2; shift 2 ;;
    http://*|https://*) url=$1; shift ;;
    *) shift ;;
  esac
done
[ "${DOWNLOAD_FAILURE:-0}" = 0 ] || exit 22
case "$url" in
  */artifacts/daemon-linux-amd64.sha256)
    if [ "${BAD_CHECKSUM:-0}" = 1 ]; then printf '%064d  daemon-linux-amd64\n' 0 > "$destination";
    else sha256sum /fixtures/daemon | sed 's|/fixtures/daemon|daemon-linux-amd64|' > "$destination"; fi ;;
  */artifacts/daemon-linux-amd64)
    if [ "${BAD_CHECKSUM:-0}" = 1 ]; then printf '#!/bin/sh\ntouch /tmp/unverified-executable-ran\n' > "$destination";
    else cp /fixtures/daemon "$destination"; fi ;;
  *) echo "Unexpected download URL: $url" >&2; exit 23 ;;
esac
MOCK_CURL
cat > /fakebin/systemctl <<'MOCK_SYSTEMCTL'
#!/bin/sh
set -eu
printf '%s\n' "$*" >> /tmp/systemctl.calls
[ "${SERVICE_FAILURE:-0}" = 0 ] || exit 1
MOCK_SYSTEMCTL
chmod 755 /fakebin/curl /fakebin/systemctl
export PATH=/fakebin:/usr/bin:/bin
# Only the download and systemd boundary are simulated. The downloaded daemon,
# configuration parser, identity generation, Ent migration and SQLite are real.
. /source/install.sh
token=bm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
next_token=bm_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
printf '%s\n' 'unrelated core sentinel' > /usr/local/bin/sing-box
core_before=$(sha256sum /usr/local/bin/sing-box)

BAD_CHECKSUM=1 bifurcation_install --panel https://panel.example --token "$token" && { echo 'Bad checksum was accepted.' >&2; exit 1; }
[ ! -e /tmp/unverified-executable-ran ]
[ ! -e /usr/local/bin/bifurcation-daemon ]
DOWNLOAD_FAILURE=1 bifurcation_install --panel https://panel.example --token "$token" && { echo 'Failed download was accepted.' >&2; exit 1; }
[ ! -e /etc/bifurcation/daemon.json ]

bifurcation_install --panel https://panel.example --token "$token"
[ -x /usr/local/libexec/bifurcation-recovery ]
grep -q '^ExecStartPre=/usr/local/libexec/bifurcation-recovery -recover-update' /etc/systemd/system/bifurcation-daemon.service
recovery_before=$(sha256sum /usr/local/libexec/bifurcation-recovery)
identity_before=$(sha256sum /var/lib/bifurcation/identity.json)
database_before=$(sha256sum /var/lib/bifurcation/state.db)
config_before=$(sha256sum /etc/bifurcation/daemon.json)
bifurcation_install --panel https://panel.example --token "$token"
[ "$(sha256sum /var/lib/bifurcation/identity.json)" = "$identity_before" ]
[ "$(sha256sum /var/lib/bifurcation/state.db)" = "$database_before" ]
[ "$(sha256sum /etc/bifurcation/daemon.json)" = "$config_before" ]
[ "$(sha256sum /usr/local/libexec/bifurcation-recovery)" = "$recovery_before" ]
bifurcation_install --panel https://panel.example --token "$next_token" && { echo 'Configuration conflict was accepted without takeover.' >&2; exit 1; }
[ "$(sha256sum /etc/bifurcation/daemon.json)" = "$config_before" ]
[ "$(sha256sum /usr/local/libexec/bifurcation-recovery)" = "$recovery_before" ]
bifurcation_install --panel https://panel.example --token "$next_token" --take-over
[ "$(sha256sum /var/lib/bifurcation/identity.json)" = "$identity_before" ]
[ "$(sha256sum /var/lib/bifurcation/state.db)" = "$database_before" ]
grep -q "$next_token" /etc/bifurcation/daemon.json
current_config=$(sha256sum /etc/bifurcation/daemon.json)
bifurcation_install --panel https://another-panel.example --token "$next_token" --take-over && { echo 'Cross-panel state reuse was accepted.' >&2; exit 1; }
[ "$(sha256sum /etc/bifurcation/daemon.json)" = "$current_config" ]
[ "$(sha256sum /var/lib/bifurcation/identity.json)" = "$identity_before" ]
[ "$(sha256sum /var/lib/bifurcation/state.db)" = "$database_before" ]
[ "$(sha256sum /usr/local/bin/sing-box)" = "$core_before" ]
! grep -q 'sing-box' /tmp/systemctl.calls
! grep -q "$token" /tmp/systemctl.calls
SERVICE_FAILURE=1 bifurcation_install --panel https://panel.example --token "$next_token" > /tmp/failed-service.log 2>&1 && { echo 'Failed service start was accepted.' >&2; exit 1; }
! grep -q 'The local daemon service is active' /tmp/failed-service.log
printf '%s\n' 'Installer safety checks passed with the real daemon; systemd was simulated.'
