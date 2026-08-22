CREATE TABLE finance_allocation_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  space_id INTEGER NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  target_percentage REAL NOT NULL CHECK (target_percentage >= 0 AND target_percentage <= 100),
  UNIQUE (space_id, name)
);

ALTER TABLE finance_holdings ADD COLUMN allocation_category_id INTEGER REFERENCES finance_allocation_categories(id) ON DELETE SET NULL;

CREATE INDEX idx_finance_allocation_categories_space_name ON finance_allocation_categories(space_id, name);
CREATE INDEX idx_finance_holdings_allocation_category ON finance_holdings(space_id, allocation_category_id);
