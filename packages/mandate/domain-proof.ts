/**
 * Domain control (§5.1): the one thing about a charter a machine actually
 * verifies. A registry MUST check it before hosting a charter, the binding is
 * re-checkable by anyone at any time, and a charter whose proof disappears is
 * suspended rather than deleted.
 *
 * Two proofs, either sufficient:
 *
 *   DNS    a TXT record at `_agentmandate.<domain>` whose value names the
 *          charter id, as `agent-charter=org_…` or as the bare id.
 *   HTTPS  `https://<domain>/.well-known/agent-charter`, whose body names the
 *          charter id, as JSON `{"charter":"org_…"}` or as plain text.
 *
 * DNS is tried first because it survives a web server being down and costs
 * the domain owner nothing to keep. HTTPS is the fallback for anyone who can
 * publish a file more easily than a record. Neither is a claim about anything
 * except that whoever controls the domain put the charter id there, which is
 * exactly what §5.1 says it means.
 *
 * The probe is an interface so a test can drive both arms without a network,
 * and so the sweep and the on-demand re-check share one implementation. The
 * probe that reaches the network is the host's to supply: this core opens no
 * socket.
 */
export const DNS_LABEL = "_agentmandate";
export const WELL_KNOWN_PATH = "/.well-known/agent-charter";

export interface DomainProbe {
  /** TXT values for a name. Each record arrives as its string chunks, the
   *  shape node's resolver returns, because a long value is split. */
  txt(name: string): Promise<string[][]>;
  /** The well-known document, or null when it cannot be fetched. */
  https(url: string): Promise<{ status: number; body: string } | null>;
}

export type ProofResult =
  | { ok: true; method: "dns" | "https" }
  | { ok: false; error: string };

/** Does this text name the charter id? `agent-charter=org_…`, a JSON object
 *  with a `charter` field, or the bare id on its own. */
export function namesCharter(text: string, orgId: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const eq = /(?:^|[\s;,])agent-charter\s*=\s*(org_[0-9a-z]{16})/i.exec(trimmed);
  if (eq && eq[1] === orgId) return true;
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as { charter?: unknown; id?: unknown };
      if (parsed.charter === orgId || parsed.id === orgId) return true;
    } catch {
      /* not JSON after all */
    }
  }
  // A plain-text well-known file holding nothing but the id.
  return trimmed.split(/\s+/).some((token) => token === orgId);
}

/**
 * Check domain control for one charter. Returns the method that proved it, or
 * a refusal that says what to publish. The refusal text is what an operator
 * reads at 2am, so it names both records verbatim.
 */
export async function checkDomainControl(
  domain: string,
  orgId: string,
  probe: DomainProbe,
): Promise<ProofResult> {
  const dnsName = `${DNS_LABEL}.${domain}`;
  try {
    const records = await probe.txt(dnsName);
    for (const chunks of records) {
      if (namesCharter(chunks.join(""), orgId)) return { ok: true, method: "dns" };
    }
  } catch {
    /* No record, or no resolver. The HTTPS arm still gets its turn. */
  }

  const url = `https://${domain}${WELL_KNOWN_PATH}`;
  const answer = await probe.https(url);
  if (answer && answer.status === 200 && namesCharter(answer.body, orgId)) {
    return { ok: true, method: "https" };
  }

  return {
    ok: false,
    error:
      `Domain control over ${domain} could not be verified for ${orgId}. ` +
      `Publish a TXT record at ${dnsName} with the value "agent-charter=${orgId}", ` +
      `or serve ${orgId} at ${url}. Either one is enough, and the check can be run again at any time.`,
  };
}
