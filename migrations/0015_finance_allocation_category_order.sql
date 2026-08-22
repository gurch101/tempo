ALTER TABLE finance_allocation_categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0);

WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY space_id ORDER BY name, id) - 1 AS position
  FROM finance_allocation_categories
)
UPDATE finance_allocation_categories
SET sort_order = (SELECT position FROM ranked WHERE ranked.id = finance_allocation_categories.id);

CREATE INDEX idx_finance_allocation_categories_space_order ON finance_allocation_categories(space_id, sort_order, id);
