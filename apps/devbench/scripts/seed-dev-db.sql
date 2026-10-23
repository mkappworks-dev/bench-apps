-- Sample data for the DB tab. The Docker devbench_test starts empty and the
-- Rust tests create and drop their own fixtures, so without this the grid has
-- nothing to show and the app looks broken while telling the truth.
--
-- Idempotent: re-running rebuilds from scratch. Safe alongside the test suite,
-- whose fixtures all use their own prefixed names.
--
-- The foreign keys are the point as much as the rows: orders.customer_id and
-- order_items.order_id/product_id are what put link icons in the grid and give
-- the referenced-row popover and its jump somewhere to go.

DROP TABLE IF EXISTS order_items, orders, products, customers CASCADE;

CREATE TABLE customers (
  id         serial PRIMARY KEY,
  email      text NOT NULL,
  name       text NOT NULL,
  tier       text NOT NULL DEFAULT 'free',
  active     boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id    serial PRIMARY KEY,
  sku   text NOT NULL,
  name  text NOT NULL,
  price numeric(10,2) NOT NULL
);

CREATE TABLE orders (
  id          serial PRIMARY KEY,
  customer_id int NOT NULL REFERENCES customers(id),
  status      text NOT NULL DEFAULT 'pending',
  amount      numeric(10,2),
  paid        boolean DEFAULT false,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id         serial PRIMARY KEY,
  order_id   int NOT NULL REFERENCES orders(id),
  product_id int NOT NULL REFERENCES products(id),
  quantity   int NOT NULL DEFAULT 1,
  unit_price numeric(10,2) NOT NULL
);

INSERT INTO customers (email, name, tier, active)
SELECT
  'user' || i || '@example.com',
  'Customer ' || i,
  (ARRAY['free','pro','enterprise'])[1 + (i % 3)],
  i % 7 <> 0
FROM generate_series(1, 500) AS i;

INSERT INTO products (sku, name, price)
SELECT 'SKU-' || (1000 + i), 'Product ' || i, ((i * 37) % 5000)::numeric / 100
FROM generate_series(1, 300) AS i;

-- Every 11th order gets a NULL note, so the grid shows NULL rendering next to
-- real text rather than a uniformly populated column.
INSERT INTO orders (customer_id, status, amount, paid, notes)
SELECT
  1 + (i % 500),
  (ARRAY['paid','pending','failed','refunded'])[1 + (i % 4)],
  ((i * 137) % 90000)::numeric / 100,
  i % 2 = 0,
  CASE WHEN i % 11 = 0 THEN NULL ELSE 'Order note ' || i END
FROM generate_series(1, 1200) AS i;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT 1 + (i % 1200), 1 + (i % 300), 1 + (i % 9), ((i * 37) % 5000)::numeric / 100
FROM generate_series(1, 1200) AS i;

SELECT
  (SELECT count(*) FROM customers)   AS customers,
  (SELECT count(*) FROM products)    AS products,
  (SELECT count(*) FROM orders)      AS orders,
  (SELECT count(*) FROM order_items) AS order_items;
