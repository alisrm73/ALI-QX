# QIR Integration Request Extension 1.3

**QX Intermediate Representation — compatible extension 1.3**

- Status: implemented on `feature/phase6-integration-review`; CI and review remain required.
- Base: QIR 1.0, 1.1, and 1.2 remain valid and retain their prior semantics.
- Scope: asynchronous `INTEGRATION.REQUEST` value expression, routed only through a trusted host-owned broker.
- No direct network, filesystem, environment, or secret-store capability is added to QX source, QIR, VM, or static browser output.

## 1. Version selection and compatibility

- Modules without newer extensions remain QIR 1.0.
- DATA.ADD / DATA.REMOVE select QIR 1.1 unless a later extension is used.
- UI.TEXT / UI.SHOW select QIR 1.2 unless a later extension is used.
- Any module containing INTEGRATION.REQUEST selects QIR 1.3.
- QIR 1.3 retains the DATA 1.1 and UI 1.2 contracts without changing their meanings.
- A module containing INTEGRATION.REQUEST is not executable by synchronous `runQIR`; it must use `runQIRAsync`.

## 2. QX source contract

```qx
DATA.CREATE(response, INTEGRATION.REQUEST("demo", "lookup", "{\"id\":1}"))
```

`INTEGRATION.REQUEST(connector, operation, payloadJson)`:

| Argument | Type | Meaning |
|---|---|---|
| connector | TXT | Registered connector identifier |
| operation | TXT | Operation identifier registered by that connector |
| payloadJson | TXT | Valid JSON text sent to the registered operation |

The expression returns TXT containing valid JSON response text. It does not accept URLs, hostnames, IP addresses, credentials, or arbitrary network destinations. The existing DATA.CREATE declaration semantics are unchanged.

The expression is invalid as a standalone command statement and requires exactly three TXT arguments.

## 3. QIR representation

The existing `COMMAND_CALL` opcode is reused.

- `operands.command`: `INTEGRATION.REQUEST`
- `operands.arguments`: exactly three TXT value references in connector/operation/payload order
- `result`: required
- `type`: TXT
- Valid only in QIR 1.3

The QIR validator rejects wrong arity, non-TXT arguments, a missing result, a non-TXT result, and use in earlier QIR versions.

## 4. VM execution boundary

- `runQIRAsync(module, { integrationBroker })` is the only VM execution API that can run a module containing INTEGRATION.REQUEST.
- `runQIR` rejects such modules before execution with `QX_VM_ASYNC_REQUIRED`.
- The broker must be supplied by trusted host code and expose a `request(connectorId, operationId, payloadJson)` method.
- Missing broker fails before program execution with `QX_VM_INTEGRATION_UNAVAILABLE`.
- The VM validates that the returned value is bounded TXT containing valid JSON.
- Broker failures are converted to a generic VM error; adapter error messages and secret-bearing details are not forwarded to QX.
- Function calls containing the expression are awaited through the VM's async execution path.
- There is no implicit retry, fallback connector, or default grant.

## 5. Broker requirements

The host-owned broker in `src/integration-broker.js`:

- accepts only pre-registered connector and operation identifiers;
- requires explicit per-operation grants covering every declared permission;
- rejects by default when a registration or grant is absent;
- validates request/response JSON and byte limits;
- enforces a timeout and a concurrent-request ceiling;
- passes an AbortSignal to trusted adapters;
- keeps credentials and destination policy inside host-controlled adapter implementations.

A connector adapter is trusted host code. If it communicates with a remote service, its own implementation must constrain the destination and enforce DNS/redirect/SSRF protections. This extension does not ship a production adapter, secret provider, or external endpoint allowlist.

## 6. Static browser backend

Static browser builds reject any QIR containing `INTEGRATION.REQUEST` with `QX_WEB_INTEGRATION_UNSUPPORTED`. The generated browser runtime does not receive a broker, URL, credential, fetch capability, or network permission. Local-only programs remain supported and keep the existing restrictive Content Security Policy.

A future browser-host bridge requires a separate reviewed contract, explicit user consent, origin isolation, and deployment security review. It is not implied by QIR 1.3.

## 7. Standard VM errors

| Code | Meaning |
|---|---|
| `QX_VM_ASYNC_REQUIRED` | The caller used synchronous VM execution for a module requiring async execution |
| `QX_VM_INTEGRATION_UNAVAILABLE` | No trusted host broker was supplied |
| `QX_VM_INTEGRATION_FAILED` | The broker operation failed; details are intentionally hidden |
| `QX_VM_INTEGRATION_RESPONSE` | The broker response was not valid bounded JSON text |

## 8. Acceptance coverage

- Semantic acceptance of the exact source form and TXT return type.
- Rejection of wrong arity, wrong argument types, and statement-position use.
- QIR 1.3 lowering, validation, serialization, and round-trip.
- Retention of DATA 1.1 and UI 1.2 behavior in QIR 1.3.
- Async VM execution through a mock/trusted broker, including a request inside a function.
- Synchronous VM rejection before adapter invocation.
- Missing broker, adapter failure sanitization, and malformed response rejection.
- Static browser build rejection and continued network-disabled local execution.

No production network integration is claimed by these tests.
