const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// SQLite setup
const db = new sqlite3.Database("./data.db", (err) => {
  if (err) return console.error(err.message);
  console.log("Connected to SQLite database.");
});

// Root check
app.get("/", (req, res) => {
  res.send("Backend is working");
});

// Get all items
app.get("/items", (req, res, next) => {
  db.all("SELECT * FROM items", [], (err, rows) => {
    if (err) return next(err);
    res.json(rows);
  });
});

// Add new item
app.post("/items", (req, res, next) => {
  const { name, stock, price } = req.body;

  if (!name || typeof name !== "string") {
    return res
      .status(400)
      .json({ error: "Item name is required and must be a string" });
  }
  if (!Number.isInteger(stock) || stock < 0) {
    return res
      .status(400)
      .json({ error: "Stock must be a non-negative integer" });
  }
  if (typeof price !== "number" || price < 0) {
    return res
      .status(400)
      .json({ error: "Price must be a non-negative number" });
  }

  const query = `INSERT INTO items (name, stock, price) VALUES (?, ?, ?)`;
  db.run(query, [name, stock, price], function (err) {
    if (err) return next(err);
    res.status(201).json({ id: this.lastID });
  });
});

// Delete item
app.delete("/items/:id", (req, res, next) => {
  const { id } = req.params;
  db.run("DELETE FROM items WHERE id = ?", [id], function (err) {
    if (err) return next(err);
    if (this.changes === 0) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.status(204).end();
  });
});

// Update item
app.put("/items/:id", (req, res, next) => {
  const { name, stock, price } = req.body;
  const { id } = req.params;

  if (!name || typeof name !== "string") {
    return res
      .status(400)
      .json({ error: "Item name is required and must be a string" });
  }
  if (!Number.isInteger(stock) || stock < 0) {
    return res
      .status(400)
      .json({ error: "Stock must be a non-negative integer" });
  }
  if (typeof price !== "number" || price < 0) {
    return res
      .status(400)
      .json({ error: "Price must be a non-negative number" });
  }

  const query = `UPDATE items SET name = ?, stock = ?, price = ? WHERE id = ?`;
  db.run(query, [name, stock, price, id], function (err) {
    if (err) return next(err);
    if (this.changes === 0) {
      return res.status(404).json({ error: "Item not found" });
    }
    res.json({ updated: this.changes });
  });
});

// Create purchase
app.post("/purchases", (req, res, next) => {
  const { customer_name, shipping_address, items } = req.body;

  if (!customer_name || typeof customer_name !== "string") {
    return res.status(400).json({ error: "Customer name is required" });
  }
  if (!shipping_address || typeof shipping_address !== "string") {
    return res.status(400).json({ error: "Shipping address is required" });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "At least one item is required" });
  }

  // Validate all items before starting transaction
  for (const item of items) {
    if (!item.item_id || !Number.isInteger(item.item_id)) {
      return res.status(400).json({ error: "Item ID must be an integer" });
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      return res
        .status(400)
        .json({ error: "Quantity must be a positive integer" });
    }
  }

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    db.run(
      `INSERT INTO purchases (customer_name, shipping_address) VALUES (?, ?)`,
      [customer_name, shipping_address],
      function (err) {
        if (err) {
          db.run("ROLLBACK");
          return next(err);
        }

        const purchaseId = this.lastID;

        const insertPurchaseItem = db.prepare(`
          INSERT INTO purchase_items (purchase_id, item_id, quantity)
          VALUES (?, ?, ?)
        `);

        const updateStock = db.prepare(`
          UPDATE items SET stock = stock - ? WHERE id = ? AND stock >= ?
        `);

        let stockError = false;

        for (const { item_id, quantity } of items) {
          insertPurchaseItem.run([purchaseId, item_id, quantity]);
          updateStock.run([quantity, item_id, quantity], function (err) {
            if (err || this.changes === 0) {
              stockError = true;
            }
          });
        }

        insertPurchaseItem.finalize();
        updateStock.finalize();

        if (stockError) {
          db.run("ROLLBACK");
          return res
            .status(400)
            .json({ error: "Insufficient stock or invalid item" });
        }

        db.run("COMMIT", (err) => {
          if (err) {
            db.run("ROLLBACK");
            return next(err);
          }
          res.status(201).json({ success: true, purchase_id: purchaseId });
        });
      }
    );
  });
});

// Get purchases with JOIN
app.get("/purchases", (req, res, next) => {
  const sql = `
    SELECT 
      purchases.id as purchase_id,
      purchases.customer_name,
      purchases.date,
      items.name as item_name,
      items.price,
      purchase_items.quantity
    FROM purchases
    JOIN purchase_items ON purchases.id = purchase_items.purchase_id
    JOIN items ON purchase_items.item_id = items.id
    ORDER BY purchases.id DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) return next(err);

    const grouped = {};
    rows.forEach((row) => {
      if (!grouped[row.purchase_id]) {
        grouped[row.purchase_id] = {
          id: row.purchase_id,
          customer_name: row.customer_name,
          date: row.date,
          items: [],
        };
      }
      grouped[row.purchase_id].items.push({
        name: row.item_name,
        price: row.price,
        quantity: row.quantity,
      });
    });

    res.json(Object.values(grouped));
  });
});

// Initialize tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      stock INTEGER NOT NULL,
      price REAL NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_name TEXT NOT NULL,
      shipping_address TEXT NOT NULL,
      date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER,
      item_id INTEGER,
      quantity INTEGER,
      FOREIGN KEY (purchase_id) REFERENCES purchases(id),
      FOREIGN KEY (item_id) REFERENCES items(id)
    )
  `);

  console.log("✅ Tables initialized.");
});

// Global error handler
app.use((err, req, res, next) => {
  console.error(err.stack || err.message);
  res.status(500).json({ error: "Internal Server Error" });
});

app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);
});
