/** A staff Xero request in plain words. A CLAIMED request whose write 05 has already taken (any state past STARTING) is
 *  settled to HANDED_OVER at the start of the next 09 run; until then it reads as handed over, not "claimed". */
export function requestStatus(d: { state: string; request: { status: string } | null }): string {
  switch (d.request?.status) {
    case 'QUEUED': return 'waiting for the automation';
    case 'CLAIMED': return d.state === 'STARTING' ? 'picked up by the automation' : 'handed over to the automation';
    case 'HANDED_OVER': return 'handed over to the automation';
    case 'REFUSED': return 'refused';
    case 'EXPIRED': return 'expired';
    default: return (d.request?.status ?? '').toLowerCase().replace('_', ' ');
  }
}
