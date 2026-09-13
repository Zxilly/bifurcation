//go:build with_acme

package singbox

import (
	"github.com/sagernet/sing-box/adapter/certificate"
	"github.com/sagernet/sing-box/service/acme"
)

func registerACME(registry *certificate.Registry) { acme.RegisterCertificateProvider(registry) }
