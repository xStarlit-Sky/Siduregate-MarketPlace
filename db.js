// Simple sqlite wrapper using better-sqlite3
const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(__dirname, 'data.sqlite'));

// Create tables if missing
db.prepare(`CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  threadId TEXT,
  messageId TEXT,
  authorId TEXT,
  title TEXT,
  type TEXT,
  description TEXT,
  imageUrl TEXT,
  status TEXT,
  createdAt INTEGER,
  archivedAt INTEGER,
  lastBump INTEGER
)`).run();

module.exports = db;