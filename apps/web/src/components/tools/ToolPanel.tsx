/** Whichever tool the map is being used for, in the phone's sheet or the desktop's panel. */

import type { MeshTool } from "../../lib/meshTool.js";
import { showOnMap } from "../../lib/nav.js";
import { setMeshTool } from "../../lib/meshTool.js";
import { closeTool } from "../../lib/toolActions.js";
import { LosView } from "./LosView.js";
import { RouteEdit } from "./RouteEdit.js";
import { WhoHears } from "./WhoHears.js";

export function ToolPanel({ tool }: { tool: MeshTool }) {
  if (tool.kind === "los") {
    const back = tool.back;
    return (
      <LosView
        tool={tool}
        onBack={
          back
            ? () => {
                setMeshTool(null);
                showOnMap(back);
              }
            : undefined
        }
        onClose={() => setMeshTool(null)}
      />
    );
  }
  if (tool.kind === "route") return <RouteEdit tool={tool} onClose={closeTool} />;
  return <WhoHears onClose={() => setMeshTool(null)} />;
}
