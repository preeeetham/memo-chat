-- A newer claim about the same subject and attribute (a changed decision, a new price) retires the
-- older one instead of leaving both looking current. Deleting the newer turn restores the older claim.
ALTER TABLE claims ADD COLUMN superseded_by text;
ALTER TABLE claims ADD COLUMN superseded_at text;
CREATE INDEX claims_subject_attr ON claims (user_id, lower(subject), lower(attribute)) WHERE superseded_by IS NULL;
