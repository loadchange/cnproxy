import NetworkExtension

class PacketTunnelProvider: NEPacketTunnelProvider {

    override func startTunnel(options: [String: NSObject]?, completionHandler: @escaping (Error?) -> Void) {
        let defaults = UserDefaults(suiteName: "group.com.loadchange.cnproxy")
        let proxyHost = defaults?.string(forKey: "proxyHost") ?? "192.168.1.1"
        let proxyPort = defaults?.integer(forKey: "proxyPort") ?? 8888

        let settings = NEPacketTunnelNetworkSettings(tunnelRemoteAddress: proxyHost)

        // Virtual TUN interface
        let ipv4 = NEIPv4Settings(addresses: ["10.8.0.2"], subnetMasks: ["255.255.255.0"])
        ipv4.includedRoutes = [NEIPv4Route.default()]
        settings.ipv4Settings = ipv4

        // DNS
        settings.dnsSettings = NEDNSSettings(servers: ["8.8.8.8", "8.8.4.4"])

        // HTTP/HTTPS proxy pointing to remote cnproxy
        let proxy = NEProxySettings()
        proxy.httpEnabled = true
        proxy.httpServer = NEProxyServer(address: proxyHost, port: proxyPort)
        proxy.httpsEnabled = true
        proxy.httpsServer = NEProxyServer(address: proxyHost, port: proxyPort)
        proxy.excludeSimpleHostnames = true
        proxy.exceptionList = ["*.local", "localhost", "127.0.0.1", proxyHost]
        settings.proxySettings = proxy

        setTunnelNetworkSettings(settings) { error in
            completionHandler(error)
        }
    }

    override func stopTunnel(with reason: NEProviderStopReason, completionHandler: @escaping () -> Void) {
        completionHandler()
    }

    override func handleAppMessage(_ messageData: Data, completionHandler: ((Data?) -> Void)?) {
        completionHandler?(nil)
    }
}
