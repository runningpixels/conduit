-- Routines: one of the user's agents on a schedule or trigger
-- (`workflows::routines`). A routine is stored as an ordinary workflow; this
-- flag only says where it is listed (on its agent's card, hidden from the
-- Workflows list by default). It is set when a routine is made and cleared
-- when the user turns it into a workflow. It is kept out of the encrypted
-- definition so lists can filter on it.
ALTER TABLE workflows ADD COLUMN routine INTEGER NOT NULL DEFAULT 0;
