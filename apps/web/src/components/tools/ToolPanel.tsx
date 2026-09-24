/** Whichever tool the map is being used for, in the phone's sheet or the desktop's panel. */

import type { MeshTool } from "../../lib/meshTool.js";
import { closeAllTools, closeTool } from "../../lib/toolActions.js";
import { LosView } from "./LosView.js";
import { RouteSheet } from "./RouteSheet.js";
import { WhoHears } from "./WhoHears.js";

export function ToolPanel({ tool }: { tool: MeshTool }) {
  if (tool.kind === "los") return <LosView tool={tool} onBack={tool.back || tool.prev ? closeTool : undefined} onClose={closeAllTools} />;
  if (tool.kind === "route") return <RouteSheet tool={tool} onClose={closeTool} />;
  return <WhoHears onClose={closeAllTools} />;
}
