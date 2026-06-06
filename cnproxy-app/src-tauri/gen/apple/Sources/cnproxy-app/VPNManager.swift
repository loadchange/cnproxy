import Foundation
import NetworkExtension

class VPNManager {
    static let shared = VPNManager()
    private var manager: NETunnelProviderManager?
    private var statusObserver: Any?

    private init() {}

    func configure(proxyHost: String, proxyPort: Int, completion: @escaping (Bool) -> Void) {
        let defaults = UserDefaults(suiteName: "group.com.loadchange.cnproxy")
        defaults?.set(proxyHost, forKey: "proxyHost")
        defaults?.set(proxyPort, forKey: "proxyPort")
        defaults?.synchronize()

        NETunnelProviderManager.loadAllFromPreferences { [weak self] managers, error in
            if let error = error {
                NSLog("[CNProxy] loadAllFromPreferences error: \(error)")
                completion(false)
                return
            }

            let mgr = managers?.first ?? NETunnelProviderManager()
            let proto = NETunnelProviderProtocol()
            proto.providerBundleIdentifier = "com.loadchange.cnproxy.PacketTunnel"
            proto.serverAddress = proxyHost
            proto.providerConfiguration = [
                "proxyHost": proxyHost,
                "proxyPort": proxyPort
            ]

            mgr.protocolConfiguration = proto
            mgr.localizedDescription = "CNProxy"
            mgr.isEnabled = true

            mgr.saveToPreferences { error in
                if let error = error {
                    NSLog("[CNProxy] saveToPreferences error: \(error)")
                    completion(false)
                    return
                }
                mgr.loadFromPreferences { error in
                    self?.manager = mgr
                    completion(error == nil)
                }
            }
        }
    }

    func connect(completion: @escaping (Bool) -> Void) {
        guard let manager = manager else {
            NETunnelProviderManager.loadAllFromPreferences { [weak self] managers, _ in
                if let mgr = managers?.first {
                    self?.manager = mgr
                    self?.startTunnel(mgr, completion: completion)
                } else {
                    completion(false)
                }
            }
            return
        }
        startTunnel(manager, completion: completion)
    }

    private func startTunnel(_ mgr: NETunnelProviderManager, completion: @escaping (Bool) -> Void) {
        do {
            try mgr.connection.startVPNTunnel()
            completion(true)
        } catch {
            NSLog("[CNProxy] startVPNTunnel error: \(error)")
            completion(false)
        }
    }

    func disconnect() {
        manager?.connection.stopVPNTunnel()
    }

    func status() -> Int {
        guard let mgr = manager else { return 0 }
        switch mgr.connection.status {
        case .disconnected, .invalid: return 0
        case .connecting, .reasserting: return 1
        case .connected: return 2
        case .disconnecting: return 3
        @unknown default: return 0
        }
    }
}

// ── C FFI for Rust/Tauri bridge ──────────────────────────────────────────────

@_cdecl("cnproxy_vpn_configure")
func cnproxy_vpn_configure(_ hostPtr: UnsafePointer<UInt8>, _ hostLen: Int32, _ port: Int32) -> Bool {
    let host = String(bytes: UnsafeBufferPointer(start: hostPtr, count: Int(hostLen)), encoding: .utf8) ?? "192.168.1.1"
    let semaphore = DispatchSemaphore(value: 0)
    var result = false
    VPNManager.shared.configure(proxyHost: host, proxyPort: Int(port)) { ok in
        result = ok
        semaphore.signal()
    }
    semaphore.wait()
    return result
}

@_cdecl("cnproxy_vpn_connect")
func cnproxy_vpn_connect() -> Bool {
    let semaphore = DispatchSemaphore(value: 0)
    var result = false
    VPNManager.shared.connect { ok in
        result = ok
        semaphore.signal()
    }
    semaphore.wait()
    return result
}

@_cdecl("cnproxy_vpn_disconnect")
func cnproxy_vpn_disconnect() {
    VPNManager.shared.disconnect()
}

@_cdecl("cnproxy_vpn_status")
func cnproxy_vpn_status() -> UInt8 {
    return UInt8(VPNManager.shared.status())
}
