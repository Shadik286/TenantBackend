-- Stores the tenant's date of birth so the form and details sheet can
-- display it without computing from any other field. Nullable — legacy
-- rows are left empty and the UI hides the row when blank.
ALTER TABLE "Tenant"
  ADD COLUMN "date_of_birth" TIMESTAMP(3);