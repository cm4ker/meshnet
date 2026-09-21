import Capacitor
import UIKit

/// Capacitor's bridge, with the plugins that live in this app rather than in a
/// package. `Main.storyboard` names this class.
class MeshViewController: CAPBridgeViewController {
    override func capacitorDidLoad() {
        bridge?.registerPluginInstance(MeshTcpPlugin())
    }
}
