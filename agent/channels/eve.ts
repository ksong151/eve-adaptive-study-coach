import { eveChannel } from "eve/channels/eve";
import { type AuthFn, localDev, placeholderAuth, vercelOidc } from "eve/channels/auth";

// localDev() only authenticates while running under `eve dev`, so this grant
// lets local evals replace tool results with stubs (evals/*.eval.ts) and has
// no effect on a production deployment.
const localDevAllowingEvalStubs: AuthFn<Request> = async (request) => {
  const caller = await localDev()(request);
  return caller ? { ...caller, allowToolStubs: true } : caller;
};

export default eveChannel({
  auth: [
    // Lets the eve TUI and your Vercel deployments reach the deployed agent.
    vercelOidc(),
    // Open on localhost for `eve dev`, the REPL, and local evals; ignored in production.
    localDevAllowingEvalStubs,
    // This placeholder will not allow browser requests in production.
    // Replace it with your app's auth provider, like Auth.js or Clerk,
    // or use none() for a public demo.
    placeholderAuth(),
  ],
});
