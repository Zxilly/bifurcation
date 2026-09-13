//go:build !with_quic

package singbox

import "github.com/sagernet/sing-box/adapter/inbound"

func registerHysteria(*inbound.Registry) {}
