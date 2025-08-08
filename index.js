const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();

const app = express();
const port = 3000;

// Middleware
app.use(cors());
app.use(express.json());

// SQLite setup
const db = new sqlite3.Database("./data.db", (err) => {
  if (err) return console.error(err.message);
  console.log("Connected to SQLite database.");
});

// Example API route
app.get("/", (req, res) => {
  res.send("Backend is working");
});

app.listen(port, () => {
  console.log(`Backend listening at http://localhost:${port}`);
});

// Get all items
app.get("/items", (req, res) => {
  db.all("SELECT * FROM items", [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Add new item
app.post("/items", (req, res) => {
  const { name, stock, price } = req.body;
  if (!name || stock == null || price == null) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const query = `INSERT INTO items (name, stock, price) VALUES (?, ?, ?)`;
  db.run(query, [name, stock, price], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: this.lastID });
  });
});

// Delete item
app.delete("/items/:id", (req, res) => {
  const { id } = req.params;
  db.run("DELETE FROM items WHERE id = ?", [id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(204).end();
  });
});

// Update item
app.put("/items/:id", (req, res) => {
  const { name, stock, price } = req.body;
  const { id } = req.params;
  if (!name || stock == null || price == null) {
    return res.status(400).json({ error: "All fields are required" });
  }

  const query = `UPDATE items SET name = ?, stock = ?, price = ? WHERE id = ?`;
  db.run(query, [name, stock, price, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ updated: this.changes });
  });
});

app.post("/purchases", (req, res) => {
  const { customer_name, shipping_address, items } = req.body;

  if (
    !customer_name ||
    !shipping_address ||
    !Array.isArray(items) ||
    items.length === 0
  ) {
    return res.status(400).json({ error: "Missing required purchase data." });
  }

  db.serialize(() => {
    db.run("BEGIN TRANSACTION");

    db.run(
      `INSERT INTO purchases (customer_name, shipping_address) VALUES (?, ?)`,
      [customer_name, shipping_address],
      function (err) {
        if (err) {
          db.run("ROLLBACK");
          return res.status(500).json({ error: err.message });
        }

        const purchaseId = this.lastID;

        const insertPurchaseItem = db.prepare(`
          INSERT INTO purchase_items (purchase_id, item_id, quantity)
          VALUES (?, ?, ?)
        `);

        const updateStock = db.prepare(`
          UPDATE items SET stock = stock - ? WHERE id = ? AND stock >= ?
        `);

        for (const item of items) {
          const { item_id, quantity } = item;

          if (!item_id || !quantity || quantity <= 0) {
            db.run("ROLLBACK");
            return res
              .status(400)
              .json({ error: "Invalid item quantity or ID." });
          }

          insertPurchaseItem.run([purchaseId, item_id, quantity]);
          updateStock.run([quantity, item_id, quantity], function (err) {
            if (err || this.changes === 0) {
              db.run("ROLLBACK");
              return res
                .status(400)
                .json({ error: "Insufficient stock or item not found." });
            }
          });
        }

        insertPurchaseItem.finalize();
        updateStock.finalize();

        db.run("COMMIT", (err) => {
          if (err) {
            db.run("ROLLBACK");
            return res.status(500).json({ error: err.message });
          }

          res.status(201).json({ success: true, purchase_id: purchaseId });
        });
      }
    );
  });
});

app.get("/purchases", (req, res) => {
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
    if (err) {
      console.error(err);
      res.status(500).json({ error: "Failed to fetch purchases" });
    } else {
      // Group rows by purchase_id
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
    }
  });
});

// app.post("/purchases", (req, res) => {});

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
