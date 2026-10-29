/**
 * Factory review, Batch 1: while STAFF_XERO_DISPATCH is off the dashboard starts no financial step it cannot finish, and
 * tells staff the way that does work. The browser and database behaviour is in web/e2e/dispatch-gate.spec.ts (dispatch
 * off) and the invoice-approval / staff-journey specs (dispatch on); this pins the switch and the words.
 */
import { describe, expect, it } from 'vitest';
import { DISPATCH_OFF, approveOffNote, staffDispatchEnabled } from '../web/lib/dispatch.ts';

describe('dashboard Xero dispatch policy', () => {
  it('is on only for exactly "on" (anything else, including unset, is off)', () => {
    expect(staffDispatchEnabled({ STAFF_XERO_DISPATCH: 'on' })).toBe(true);
    for (const v of [undefined, '', 'ON', 'true', '1', 'on ', 'off']) expect(staffDispatchEnabled({ STAFF_XERO_DISPATCH: v }), String(v)).toBe(false);
  });

  it('every refused step says nothing happened and names the path that works; none sends staff to a path that refuses them', () => {
    expect(DISPATCH_OFF.prepare).toContain('prepare and approve it in Airtable');
    expect(DISPATCH_OFF.approve).toContain('Nothing was approved');
    expect(DISPATCH_OFF.approve).toContain('reject it here');
    expect(DISPATCH_OFF.reissueRequest).toContain('Nothing was requested');
    expect(DISPATCH_OFF.reissueApprove).toContain('Nothing was approved');
    expect(DISPATCH_OFF.reissueApprove).toContain('expires by itself');
    // The original message told the approver of a DASHBOARD preview to "approve in Airtable", which the database refuses.
    expect(approveOffNote('dashboard')).not.toMatch(/approve (it )?in Airtable/i);
    expect(approveOffNote('dashboard')).toContain('Reject it here');
    for (const via of ['airtable', 'copilot'] as const) expect(approveOffNote(via)).toContain('Approve it in Airtable');
  });
});
