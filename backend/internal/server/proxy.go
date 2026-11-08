package server

import (
	"errors"
	"net"
	"net/netip"
	"strconv"
	"strings"
)

var cloudflareRanges = []string{"173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22", "2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"}

func configureProxy(c *Config, value string) error {
	value = strings.TrimSpace(value)
	if hops, e := strconv.Atoi(value); e == nil {
		c.TrustedHops = max(0, hops)
		return nil
	}
	aliases := map[string][]string{"loopback": {"127.0.0.0/8", "::1/128"}, "linklocal": {"169.254.0.0/16", "fe80::/10"}, "uniquelocal": {"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"}, "cloudflare": cloudflareRanges}
	for _, part := range strings.Split(value, ",") {
		part = strings.TrimSpace(part)
		if part == "" || part == "false" {
			continue
		}
		ranges := aliases[strings.ToLower(part)]
		if ranges == nil {
			ranges = []string{part}
		}
		for _, value := range ranges {
			if ip := net.ParseIP(value); ip != nil {
				bits := 128
				if ip.To4() != nil {
					bits = 32
				}
				value += "/" + strconv.Itoa(bits)
			}
			_, network, e := net.ParseCIDR(value)
			if e != nil {
				return errors.New("invalid_trusted_proxy")
			}
			c.TrustedProxies = append(c.TrustedProxies, network)
		}
	}
	return nil
}
func cloudflareIP(ip netip.Addr) bool {
	for _, s := range cloudflareRanges {
		prefix, _ := netip.ParsePrefix(s)
		if prefix.Contains(ip.Unmap()) {
			return true
		}
	}
	return false
}
