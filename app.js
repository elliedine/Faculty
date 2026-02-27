'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const expressLayouts = require('express-ejs-layouts');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const app = express();

const DB_DIR = path.join(__dirname, 'instance');
fs.mkdirSync(DB_DIR, { recursive: true });
const DATABASE = process.env.DATABASE || path.join(DB_DIR, 'faculty.db');

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'static')));

app.use(session({
  secret: process.env.SECRET_KEY || require('crypto').randomBytes(24).toString('hex'),
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  },
}));
app.use(flash());

// Make flash messages and session available in all templates
app.use((req, res, next) => {
  res.locals.session = req.session;
  res.locals.messages = req.flash();
  next();
});

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

function getDb() {
  const db = new Database(DATABASE);
  db.pragma('foreign_keys = ON');
  return db;
}

function initDb() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      full_name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('student','instructor'))
    );

    CREATE TABLE IF NOT EXISTS departments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      code TEXT UNIQUE NOT NULL
    );

    CREATE TABLE IF NOT EXISTS instructors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER UNIQUE NOT NULL REFERENCES users(id),
      department_id INTEGER NOT NULL REFERENCES departments(id),
      status TEXT NOT NULL DEFAULT 'In' CHECK(status IN ('In','Out','On Leave','On Travel'))
    );

    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instructor_id INTEGER NOT NULL REFERENCES instructors(id),
      schedule_type TEXT NOT NULL CHECK(schedule_type IN ('leave','travel')),
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instructor_id INTEGER NOT NULL REFERENCES instructors(id),
      action TEXT NOT NULL,
      details TEXT,
      timestamp TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  db.close();
}

function seedDb() {
  const db = getDb();

  const count = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (count > 0) {
    db.close();
    return;
  }

  const departments = [
    ['College of Computing Studies', 'CCS'],
    ['College of Engineering', 'COE'],
    ['College of Education', 'CED'],
    ['College of Arts and Sciences', 'CAS'],
    ['College of Business Administration', 'CBA'],
  ];

  const insertDept = db.prepare('INSERT INTO departments (name, code) VALUES (?, ?)');
  for (const [name, code] of departments) {
    insertDept.run(name, code);
  }

  const pw = bcrypt.hashSync('password', 10);

  const instructors = [
    ['jdoe',     pw, 'John Doe',       'instructor', 1, 'In'],
    ['asmith',   pw, 'Anna Smith',     'instructor', 1, 'Out'],
    ['bcruz',    pw, 'Benjamin Cruz',  'instructor', 2, 'On Leave'],
    ['mgarcia',  pw, 'Maria Garcia',   'instructor', 2, 'In'],
    ['rlopez',   pw, 'Roberto Lopez',  'instructor', 3, 'On Travel'],
    ['lreyes',   pw, 'Lorna Reyes',    'instructor', 3, 'In'],
    ['pnavarro', pw, 'Pedro Navarro',  'instructor', 4, 'Out'],
    ['ctan',     pw, 'Carmen Tan',     'instructor', 4, 'In'],
    ['jsantos',  pw, 'Jose Santos',    'instructor', 5, 'In'],
    ['mvillar',  pw, 'Marta Villar',   'instructor', 5, 'On Leave'],
  ];

  const insertUser = db.prepare(
    'INSERT INTO users (username, password, full_name, role) VALUES (?, ?, ?, ?)'
  );
  const insertInstructor = db.prepare(
    'INSERT INTO instructors (user_id, department_id, status) VALUES (?, ?, ?)'
  );
  const insertLog = db.prepare(
    'INSERT INTO activity_log (instructor_id, action, details) VALUES (?, ?, ?)'
  );

  const seedAll = db.transaction(() => {
    for (const [uname, upw, fname, role, deptId, status] of instructors) {
      const { lastInsertRowid: uid } = insertUser.run(uname, upw, fname, role);
      const { lastInsertRowid: instId } = insertInstructor.run(uid, deptId, status);
      insertLog.run(instId, 'Status set', `Status set to ${status}`);
    }
    // Student account
    insertUser.run('student', pw, 'Juan Antonio', 'student');
  });

  seedAll();
  db.close();
}

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------

function loginRequired(req, res, next) {
  if (!req.session.user_id) {
    return res.redirect('/login');
  }
  next();
}

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many login attempts. Please try again later.',
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

app.get('/', (req, res) => {
  if (req.session.user_id) {
    return res.redirect('/select');
  }
  res.redirect('/login');
});

app.get('/login', (req, res) => {
  res.render('login', { layout: false });
});

app.post('/login', loginLimiter, (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  db.close();
  if (user && bcrypt.compareSync(password, user.password)) {
    req.session.user_id = user.id;
    req.session.full_name = user.full_name;
    req.session.role = user.role;
    return res.redirect('/select');
  }
  req.flash('error', 'Invalid username or password.');
  res.redirect('/login');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/select', loginRequired, (req, res) => {
  res.render('role_select', { title: 'Select Role - Faculty Locator' });
});

// ---- Student views --------------------------------------------------------

app.get('/student', loginRequired, apiLimiter, (req, res) => {
  const db = getDb();
  const departments = db.prepare('SELECT * FROM departments ORDER BY name').all();
  db.close();
  res.render('student_dashboard', { title: 'Student Dashboard - Faculty Locator', departments });
});

app.get('/student/department/:deptId', loginRequired, apiLimiter, (req, res) => {
  const deptId = parseInt(req.params.deptId, 10);
  const db = getDb();
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(deptId);
  if (!dept) {
    db.close();
    req.flash('error', 'Department not found.');
    return res.redirect('/student');
  }
  const instructors = db.prepare(`
    SELECT i.id, u.full_name, i.status
    FROM instructors i
    JOIN users u ON u.id = i.user_id
    WHERE i.department_id = ?
    ORDER BY u.full_name
  `).all(deptId);
  db.close();
  res.render('department_detail', {
    title: `${dept.name} - Faculty Locator`,
    department: dept,
    instructors,
  });
});

// ---- Instructor views -----------------------------------------------------

app.get('/instructor', loginRequired, apiLimiter, (req, res) => {
  if (req.session.role !== 'instructor') {
    req.flash('error', 'Access denied.');
    return res.redirect('/select');
  }
  const db = getDb();
  const instructor = db.prepare(`
    SELECT i.*, u.full_name, d.name AS dept_name
    FROM instructors i
    JOIN users u ON u.id = i.user_id
    JOIN departments d ON d.id = i.department_id
    WHERE i.user_id = ?
  `).get(req.session.user_id);
  if (!instructor) {
    db.close();
    req.flash('error', 'Instructor profile not found.');
    return res.redirect('/select');
  }
  const schedules = db.prepare(`
    SELECT * FROM schedules
    WHERE instructor_id = ?
    ORDER BY start_date DESC
  `).all(instructor.id);
  const logs = db.prepare(`
    SELECT * FROM activity_log
    WHERE instructor_id = ?
    ORDER BY timestamp DESC
    LIMIT 20
  `).all(instructor.id);
  db.close();
  res.render('instructor_dashboard', {
    title: 'Instructor Dashboard - Faculty Locator',
    instructor,
    schedules,
    logs,
  });
});

app.post('/instructor/status', loginRequired, apiLimiter, (req, res) => {
  if (req.session.role !== 'instructor') {
    req.flash('error', 'Access denied.');
    return res.redirect('/select');
  }
  const newStatus = req.body.status;
  if (!['In', 'Out', 'On Leave', 'On Travel'].includes(newStatus)) {
    req.flash('error', 'Invalid status.');
    return res.redirect('/instructor');
  }
  const db = getDb();
  const instructor = db.prepare('SELECT id, status FROM instructors WHERE user_id = ?').get(req.session.user_id);
  db.prepare('UPDATE instructors SET status = ? WHERE id = ?').run(newStatus, instructor.id);
  db.prepare('INSERT INTO activity_log (instructor_id, action, details) VALUES (?, ?, ?)').run(
    instructor.id, 'Status changed', `Changed from ${instructor.status} to ${newStatus}`
  );
  db.close();
  req.flash('success', `Status updated to ${newStatus}.`);
  res.redirect('/instructor');
});

app.post('/instructor/schedule', loginRequired, apiLimiter, (req, res) => {
  if (req.session.role !== 'instructor') {
    req.flash('error', 'Access denied.');
    return res.redirect('/select');
  }
  const { schedule_type, start_date, end_date, reason = '' } = req.body;

  if (!['leave', 'travel'].includes(schedule_type)) {
    req.flash('error', 'Invalid schedule type.');
    return res.redirect('/instructor');
  }
  if (!start_date || !end_date) {
    req.flash('error', 'Start and end dates are required.');
    return res.redirect('/instructor');
  }

  const db = getDb();
  const instructor = db.prepare('SELECT id FROM instructors WHERE user_id = ?').get(req.session.user_id);
  db.prepare(
    'INSERT INTO schedules (instructor_id, schedule_type, start_date, end_date, reason) VALUES (?, ?, ?, ?, ?)'
  ).run(instructor.id, schedule_type, start_date, end_date, reason.trim());
  const newStatus = schedule_type === 'leave' ? 'On Leave' : 'On Travel';
  db.prepare('UPDATE instructors SET status = ? WHERE id = ?').run(newStatus, instructor.id);
  db.prepare('INSERT INTO activity_log (instructor_id, action, details) VALUES (?, ?, ?)').run(
    instructor.id,
    `Scheduled ${schedule_type}`,
    `${schedule_type.charAt(0).toUpperCase() + schedule_type.slice(1)} from ${start_date} to ${end_date}: ${reason.trim()}`
  );
  db.close();
  req.flash('success', `${schedule_type.charAt(0).toUpperCase() + schedule_type.slice(1)} scheduled successfully.`);
  res.redirect('/instructor');
});

// ---------------------------------------------------------------------------
// App startup
// ---------------------------------------------------------------------------

initDb();
seedDb();

const PORT = process.env.PORT || 5000;
if (require.main === module) {
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Faculty Locator running on http://0.0.0.0:${PORT}`);
  });
}

module.exports = { app, initDb, seedDb, getDb };
