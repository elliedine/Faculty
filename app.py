import os
import sqlite3
from datetime import datetime, date
from functools import wraps

from flask import (
    Flask, render_template, request, redirect, url_for,
    session, flash, g, jsonify
)
from werkzeug.security import generate_password_hash, check_password_hash

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", os.urandom(24))

DATABASE = os.path.join(app.instance_path, "faculty.db")

os.makedirs(app.instance_path, exist_ok=True)

# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DATABASE)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_db():
    db = get_db()
    db.executescript("""
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
    """)
    db.commit()


def seed_db():
    """Insert demo data when the database is empty."""
    db = get_db()
    if db.execute("SELECT COUNT(*) FROM users").fetchone()[0] > 0:
        return

    # Departments
    departments = [
        ("College of Computing Studies", "CCS"),
        ("College of Engineering", "COE"),
        ("College of Education", "CED"),
        ("College of Arts and Sciences", "CAS"),
        ("College of Business Administration", "CBA"),
    ]
    for name, code in departments:
        db.execute("INSERT INTO departments (name, code) VALUES (?, ?)", (name, code))

    # Instructors (password is 'password' for all demo accounts)
    pw = generate_password_hash("password")
    instructors = [
        ("jdoe", pw, "John Doe", "instructor", 1, "In"),
        ("asmith", pw, "Anna Smith", "instructor", 1, "Out"),
        ("bcruz", pw, "Benjamin Cruz", "instructor", 2, "On Leave"),
        ("mgarcia", pw, "Maria Garcia", "instructor", 2, "In"),
        ("rlopez", pw, "Roberto Lopez", "instructor", 3, "On Travel"),
        ("lreyes", pw, "Lorna Reyes", "instructor", 3, "In"),
        ("pnavarro", pw, "Pedro Navarro", "instructor", 4, "Out"),
        ("ctan", pw, "Carmen Tan", "instructor", 4, "In"),
        ("jsantos", pw, "Jose Santos", "instructor", 5, "In"),
        ("mvillar", pw, "Marta Villar", "instructor", 5, "On Leave"),
    ]
    for uname, upw, fname, role, dept_id, status in instructors:
        db.execute(
            "INSERT INTO users (username, password, full_name, role) VALUES (?, ?, ?, ?)",
            (uname, upw, fname, role),
        )
        uid = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        db.execute(
            "INSERT INTO instructors (user_id, department_id, status) VALUES (?, ?, ?)",
            (uid, dept_id, status),
        )
        inst_id = db.execute("SELECT last_insert_rowid()").fetchone()[0]
        db.execute(
            "INSERT INTO activity_log (instructor_id, action, details) VALUES (?, ?, ?)",
            (inst_id, "Status set", f"Status set to {status}"),
        )

    # Student account
    db.execute(
        "INSERT INTO users (username, password, full_name, role) VALUES (?, ?, ?, ?)",
        ("student", pw, "Juan Antonio", "student"),
    )

    db.commit()


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------

def login_required(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if "user_id" not in session:
            return redirect(url_for("login"))
        return f(*args, **kwargs)
    return decorated


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    if "user_id" in session:
        return redirect(url_for("role_select"))
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        username = request.form.get("username", "").strip()
        password = request.form.get("password", "")
        db = get_db()
        user = db.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
        if user and check_password_hash(user["password"], password):
            session["user_id"] = user["id"]
            session["full_name"] = user["full_name"]
            session["role"] = user["role"]
            return redirect(url_for("role_select"))
        flash("Invalid username or password.", "error")
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/select")
@login_required
def role_select():
    return render_template("role_select.html")


# ---- Student views --------------------------------------------------------

@app.route("/student")
@login_required
def student_dashboard():
    db = get_db()
    departments = db.execute("SELECT * FROM departments ORDER BY name").fetchall()
    return render_template("student_dashboard.html", departments=departments)


@app.route("/student/department/<int:dept_id>")
@login_required
def department_detail(dept_id):
    db = get_db()
    dept = db.execute("SELECT * FROM departments WHERE id = ?", (dept_id,)).fetchone()
    if not dept:
        flash("Department not found.", "error")
        return redirect(url_for("student_dashboard"))
    instructors = db.execute("""
        SELECT i.id, u.full_name, i.status
        FROM instructors i
        JOIN users u ON u.id = i.user_id
        WHERE i.department_id = ?
        ORDER BY u.full_name
    """, (dept_id,)).fetchall()
    return render_template("department_detail.html", department=dept, instructors=instructors)


# ---- Instructor views -----------------------------------------------------

@app.route("/instructor")
@login_required
def instructor_dashboard():
    if session.get("role") != "instructor":
        flash("Access denied.", "error")
        return redirect(url_for("role_select"))
    db = get_db()
    instructor = db.execute("""
        SELECT i.*, u.full_name, d.name AS dept_name
        FROM instructors i
        JOIN users u ON u.id = i.user_id
        JOIN departments d ON d.id = i.department_id
        WHERE i.user_id = ?
    """, (session["user_id"],)).fetchone()
    if not instructor:
        flash("Instructor profile not found.", "error")
        return redirect(url_for("role_select"))

    schedules = db.execute("""
        SELECT * FROM schedules
        WHERE instructor_id = ?
        ORDER BY start_date DESC
    """, (instructor["id"],)).fetchall()

    logs = db.execute("""
        SELECT * FROM activity_log
        WHERE instructor_id = ?
        ORDER BY timestamp DESC
        LIMIT 20
    """, (instructor["id"],)).fetchall()

    return render_template(
        "instructor_dashboard.html",
        instructor=instructor,
        schedules=schedules,
        logs=logs,
    )


@app.route("/instructor/status", methods=["POST"])
@login_required
def update_status():
    if session.get("role") != "instructor":
        flash("Access denied.", "error")
        return redirect(url_for("role_select"))
    new_status = request.form.get("status")
    if new_status not in ("In", "Out", "On Leave", "On Travel"):
        flash("Invalid status.", "error")
        return redirect(url_for("instructor_dashboard"))
    db = get_db()
    instructor = db.execute(
        "SELECT id FROM instructors WHERE user_id = ?", (session["user_id"],)
    ).fetchone()
    old = db.execute("SELECT status FROM instructors WHERE id = ?", (instructor["id"],)).fetchone()
    db.execute("UPDATE instructors SET status = ? WHERE id = ?", (new_status, instructor["id"]))
    db.execute(
        "INSERT INTO activity_log (instructor_id, action, details) VALUES (?, ?, ?)",
        (instructor["id"], "Status changed", f"Changed from {old['status']} to {new_status}"),
    )
    db.commit()
    flash(f"Status updated to {new_status}.", "success")
    return redirect(url_for("instructor_dashboard"))


@app.route("/instructor/schedule", methods=["POST"])
@login_required
def add_schedule():
    if session.get("role") != "instructor":
        flash("Access denied.", "error")
        return redirect(url_for("role_select"))
    schedule_type = request.form.get("schedule_type")
    start_date = request.form.get("start_date")
    end_date = request.form.get("end_date")
    reason = request.form.get("reason", "").strip()

    if schedule_type not in ("leave", "travel"):
        flash("Invalid schedule type.", "error")
        return redirect(url_for("instructor_dashboard"))
    if not start_date or not end_date:
        flash("Start and end dates are required.", "error")
        return redirect(url_for("instructor_dashboard"))

    db = get_db()
    instructor = db.execute(
        "SELECT id FROM instructors WHERE user_id = ?", (session["user_id"],)
    ).fetchone()
    db.execute(
        "INSERT INTO schedules (instructor_id, schedule_type, start_date, end_date, reason) "
        "VALUES (?, ?, ?, ?, ?)",
        (instructor["id"], schedule_type, start_date, end_date, reason),
    )
    new_status = "On Leave" if schedule_type == "leave" else "On Travel"
    db.execute("UPDATE instructors SET status = ? WHERE id = ?", (new_status, instructor["id"]))
    db.execute(
        "INSERT INTO activity_log (instructor_id, action, details) VALUES (?, ?, ?)",
        (instructor["id"], f"Scheduled {schedule_type}",
         f"{schedule_type.title()} from {start_date} to {end_date}: {reason}"),
    )
    db.commit()
    flash(f"{schedule_type.title()} scheduled successfully.", "success")
    return redirect(url_for("instructor_dashboard"))


# ---------------------------------------------------------------------------
# App startup
# ---------------------------------------------------------------------------

with app.app_context():
    init_db()
    seed_db()

if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
