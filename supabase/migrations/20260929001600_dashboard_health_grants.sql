-- Phase 6: the System Health page shows the executable invariants. integrity_check() is read-only (STABLE,
-- SECURITY DEFINER, returns rule outcomes and business references only), so the dashboard may run it.
grant execute on function integrity_check() to roofops_dashboard;
