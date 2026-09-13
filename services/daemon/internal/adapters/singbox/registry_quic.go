//go:build with_quic

package singbox

import (
	"github.com/sagernet/sing-box/adapter/inbound"
	"github.com/sagernet/sing-box/protocol/hysteria2"
)

func registerHysteria(registry *inbound.Registry) { hysteria2.RegisterInbound(registry) }
