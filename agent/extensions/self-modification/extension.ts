// eve dev mounts this extension by default. It gives the model a subagent
// that edits files under agent/, which this agent must not have, so the
// mount is kept with local self-modification turned off.
import selfModification from "eve/self-modification/local";

export default selfModification({ local: { enabled: false } });
