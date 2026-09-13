//go:build !with_acme

package singbox

import "github.com/sagernet/sing-box/adapter/certificate"

func registerACME(*certificate.Registry) {}
