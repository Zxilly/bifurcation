package singbox

import (
	"context"

	box "github.com/sagernet/sing-box"
	"github.com/sagernet/sing-box/adapter/certificate"
	"github.com/sagernet/sing-box/adapter/endpoint"
	"github.com/sagernet/sing-box/adapter/inbound"
	"github.com/sagernet/sing-box/adapter/outbound"
	serviceRegistry "github.com/sagernet/sing-box/adapter/service"
	"github.com/sagernet/sing-box/dns"
	"github.com/sagernet/sing-box/dns/transport"
	"github.com/sagernet/sing-box/dns/transport/hosts"
	"github.com/sagernet/sing-box/dns/transport/local"
	"github.com/sagernet/sing-box/protocol/direct"
	"github.com/sagernet/sing-box/protocol/trojan"
	"github.com/sagernet/sing/service/filemanager"
)

func registryContext(ctx context.Context, directory string) context.Context {
	ins := inbound.NewRegistry()
	trojan.RegisterInbound(ins)
	registerHysteria(ins)
	outs := outbound.NewRegistry()
	direct.RegisterOutbound(outs)
	dnsRegistry := dns.NewTransportRegistry()
	transport.RegisterTCP(dnsRegistry)
	transport.RegisterUDP(dnsRegistry)
	transport.RegisterTLS(dnsRegistry)
	transport.RegisterHTTPS(dnsRegistry)
	hosts.RegisterTransport(dnsRegistry)
	local.RegisterTransport(dnsRegistry)
	ctx = filemanager.WithDefault(ctx, directory, directory, -1, -1)
	return box.Context(ctx, ins, outs, endpoint.NewRegistry(), dnsRegistry, serviceRegistry.NewRegistry(), certificate.NewRegistry())
}
