/** Only genuine SDK environment/identifier exceptions admit one alternate full
 * verification. Optional Sandbox appAppleId can fail Production identity first. */
export async function verifiedAppleEvent(runtimeFor, signedPayload, environment) {
  if(!['Production','Sandbox'].includes(environment))throw new Error('Invalid store environment');
  const runtime=await runtimeFor(environment);
  try { return {runtime,event:await runtime.provider.notification(signedPayload)}; }
  catch(error) {
    if(environment!=='Production')throw error;
    const alternate=runtime.mayVerifySandbox ? runtime.mayVerifySandbox(error) : runtime.isEnvironmentMismatch?.(error);
    if(!alternate)throw error;
    const sandbox=await runtimeFor('Sandbox');
    return {runtime:sandbox,event:await sandbox.provider.notification(signedPayload)};
  }
}
