ROOFOPS SYNTHETIC DATASET
Generated deterministically with seed 20260928.
All people, companies, phone numbers, emails and business records are fictional demo data.

Primary file:
- roofops_master_operations.csv : flat quote-centric dataset for Airtable/Claude/BI quick start.

Normalized relational files:
- customers.csv (40)
- properties.csv (52)
- quotes.csv (65)
- projects.csv (30)
- suppliers.csv (6)
- products.csv (45)
- purchase_orders.csv (35)
- invoices.csv (38)
- project_events.csv (110)
- site_notes.csv (75)
- documents.csv (60)
- workflow_exceptions.csv (12)
- processed_events.csv (81)

Intentionally seeded scenarios include:
- 3 delayed projects
- 2 projects awaiting supplier confirmation
- 1 completed project missing compliance photos
- 1 accepted quote where project creation failed
- 2 overdue invoices
- 1 duplicate customer candidate
- 1 supplier delivery delay
- 1 quote missing roof measurement
- 1 job scheduled before materials arrive
- 1 unresolved automation exception
- duplicate webhook/idempotency event fixture
- rate-limit, timeout, validation, auth, schema and ambiguous-write exception examples

No real customer or Roof Company data is included.
