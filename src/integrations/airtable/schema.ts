/**
 * Real Airtable base "RoofOps Demo" (synthetic data only). IDs are not secrets.
 * Created 2026-09-29 via the Airtable API; see docs/phase2.md for provenance.
 */
export const AIRTABLE_BASE_ID = 'appMc8V0Wm29tEeHQ';

export const AT = {
  customers: {
    table: 'tblHKX79FJFHn5FDc',
    f: { id: 'fldzmWSHtLVZ4OTmZ', name: 'fldI46VewtlNRnwui', email: 'fldNcSkEiFnb8m4XP', phone: 'fldvBKPgd3UeIDYO4', type: 'fldisVgB2WysksjwW',
         preferred: 'fldfNc5n8m2kjiRcB', since: 'fldNu4bbDXjMbwmZ8', duplicateOf: 'fldPXNXPyYie2kKQk', roofopsId: 'fldDClu1e0ffwnojn' },
  },
  suppliers: {
    table: 'tbloPJwCIcdIZQFVK',
    f: { id: 'fldNy5hhua9oCbrge', name: 'fldmyVulHN1hsCE8f', email: 'fldPtnT9heTBGTFEM', phone: 'fldtNq7DluPgIM1rn', leadTime: 'fldfXKzmQJYzbzgZY', roofopsId: 'fldLNYP5FsVaR6TFk' },
  },
  properties: {
    table: 'tblSYcCqId9wTMg3c',
    f: { id: 'fldIy8ab7Ky67jL31', address: 'fldu0CsGG5uPOVbRN', suburb: 'fldl6gKbKuZSF9MJG', state: 'fldYjfr3STs04XDZr', postcode: 'flduw5J4VyRoOqEE2',
         type: 'fldMH8wYXmkAYXCxe', storeys: 'fldhsHUPCZ0pMbXeV', access: 'fldP4PWGxdLZrA5ge', owner: 'fldVpX0MOcA8TnGvo', roofopsId: 'fldm6rtleyV6yp8ZS' },
  },
  quotes: {
    table: 'tblzenPRNVV5O7lZP',
    f: { number: 'fldyP20HNafS614d5', customer: 'fld4LsEu8c9EMFj0h', property: 'fldisUv1ckHz2Detv', status: 'fldQpTa5tvrzlNg1h', version: 'fldEjEqlzE8Y0M1nf',
         amount: 'fldbfUE8DVh1Dwjfs', jobType: 'fldOaXGsOgYHuWFYg', roofType: 'fldhY6d0ikMnsc7D3', roofArea: 'fldLjvBaV1EFB5RMG', estimator: 'fld5Bz9FDhJSPibPk',
         leadSource: 'flduF4QFGUWbkuR2d', createdOn: 'fldHSFkvwuVLfAS7J', sentOn: 'fldMnoHiondm5jBWv', acceptedOn: 'fldfhsHggkGd8GKVq', lostReason: 'fld1sZibwdMVnI4Hd',
         automationStatus: 'fldVc9vw112vrP33n', automationMessage: 'fldC70PHs4gQh8M42', roofopsId: 'fldVUpqZkVKid3Fyy', projects: 'flduJm0iR7pBb157b' },
  },
  projects: {
    table: 'tblvUPIoebC3zoacv',
    f: { number: 'fldhhnQXlbuFaveK3', quote: 'fld08eKCeuDCsJLjz', customer: 'fldG4mPoV6sUkA9rM', status: 'fldi2Qwz1dAh2tcTE', pm: 'fldnZcRBxG7hTebD5',
         plannedStart: 'fld8rf6RZLgfs6Ron', plannedCompletion: 'fldvZtiassZEgLMAN', actualStart: 'fldIje5e0a72cBfVD', actualCompletion: 'fldWKRobTLlOjeN9j',
         materialTask: 'fld93YzhrpOVIviRY', driveFolder: 'fldgVDT29UOOOtlqO', roofopsId: 'fldc4T0AgU3zCmANC',
         // Phase 3: invoice approval UI (Invoice Action is the staff "button"; the rest is written by [RoofOps] 04)
         invoiceAction: 'fldYnINTdtOckOzK4', invoiceStatus: 'fldPuGgo27oWLKB5R', invoicePreview: 'fldt9KIOPXh3c3pGU',
         invoiceAmount: 'fld5JDnWI3RFehQxA', xeroInvoiceNumber: 'fldgkN0Vm6k1MZLJp', xeroInvoiceId: 'fld3sDI9LIX8Voo4u' },
  },
  purchaseOrders: {
    table: 'tbluIbl4zpMiAlMVw',
    f: { number: 'fld1yW7kd8vY975Tj', project: 'fldDVMu2hgtSVuJyR', supplier: 'fldnYTAgdcNXWUMfP', status: 'fldMtDddp1Rm4tDHf', poDate: 'fldqNNcA85jAC9FxM',
         expected: 'fldqkJourPRGAcJya', subtotal: 'fld8Muyf7XVB91CjK', supplierRef: 'fldJ4Z5Rg5adnEFU0', roofopsId: 'fldnzaXx4TTTjCakj' },
  },
} as const;
