"""Tests for the Faculty Locator application."""
import os
import tempfile
import pytest
from app import app, get_db, init_db, seed_db


@pytest.fixture
def client():
    """Create a test client with a temporary database."""
    db_fd, db_path = tempfile.mkstemp(suffix=".db")
    app.config["TESTING"] = True
    app.config["SECRET_KEY"] = "test-secret"

    # Override DATABASE path
    import app as app_module
    original_db = app_module.DATABASE
    app_module.DATABASE = db_path

    with app.app_context():
        init_db()
        seed_db()

    with app.test_client() as client:
        yield client

    app_module.DATABASE = original_db
    os.close(db_fd)
    os.unlink(db_path)


def login(client, username, password):
    return client.post("/login", data={
        "username": username,
        "password": password,
    }, follow_redirects=True)


def test_login_page_renders(client):
    resp = client.get("/login")
    assert resp.status_code == 200
    assert b"Sign In" in resp.data
    assert b"Faculty Locator" in resp.data


def test_login_success_student(client):
    resp = login(client, "student", "password")
    assert resp.status_code == 200
    assert b"STUDENT" in resp.data


def test_login_success_instructor(client):
    resp = login(client, "jdoe", "password")
    assert resp.status_code == 200
    assert b"INSTRUCTOR" in resp.data


def test_login_failure(client):
    resp = login(client, "bad", "credentials")
    assert b"Invalid username or password" in resp.data


def test_logout(client):
    login(client, "student", "password")
    resp = client.get("/logout", follow_redirects=True)
    assert b"Sign In" in resp.data


def test_role_select_requires_login(client):
    resp = client.get("/select", follow_redirects=True)
    assert b"Sign In" in resp.data


def test_student_dashboard_shows_departments(client):
    login(client, "student", "password")
    resp = client.get("/student")
    assert resp.status_code == 200
    assert b"Departments" in resp.data
    assert b"CCS" in resp.data
    assert b"College of Computing Studies" in resp.data
    assert b"COE" in resp.data


def test_department_detail_shows_instructors(client):
    login(client, "student", "password")
    resp = client.get("/student/department/1")
    assert resp.status_code == 200
    assert b"John Doe" in resp.data
    assert b"Anna Smith" in resp.data


def test_department_detail_shows_status(client):
    login(client, "student", "password")
    resp = client.get("/student/department/1")
    assert b"In" in resp.data
    assert b"Out" in resp.data


def test_department_not_found(client):
    login(client, "student", "password")
    resp = client.get("/student/department/999", follow_redirects=True)
    assert b"Department not found" in resp.data


def test_instructor_dashboard(client):
    login(client, "jdoe", "password")
    resp = client.get("/instructor")
    assert resp.status_code == 200
    assert b"Instructor Dashboard" in resp.data
    assert b"John Doe" in resp.data
    assert b"My Status" in resp.data
    assert b"Activity Log" in resp.data


def test_instructor_dashboard_denied_for_student(client):
    login(client, "student", "password")
    resp = client.get("/instructor", follow_redirects=True)
    assert b"Access denied" in resp.data


def test_update_status(client):
    login(client, "jdoe", "password")
    resp = client.post("/instructor/status", data={"status": "Out"}, follow_redirects=True)
    assert b"Status updated to Out" in resp.data
    # Verify the status badge shows
    assert b"Out" in resp.data


def test_update_status_invalid(client):
    login(client, "jdoe", "password")
    resp = client.post("/instructor/status", data={"status": "Invalid"}, follow_redirects=True)
    assert b"Invalid status" in resp.data


def test_add_schedule_leave(client):
    login(client, "jdoe", "password")
    resp = client.post("/instructor/schedule", data={
        "schedule_type": "leave",
        "start_date": "2026-03-01",
        "end_date": "2026-03-05",
        "reason": "Personal leave",
    }, follow_redirects=True)
    assert b"Leave scheduled successfully" in resp.data
    assert b"Personal leave" in resp.data


def test_add_schedule_travel(client):
    login(client, "jdoe", "password")
    resp = client.post("/instructor/schedule", data={
        "schedule_type": "travel",
        "start_date": "2026-04-01",
        "end_date": "2026-04-03",
        "reason": "Conference",
    }, follow_redirects=True)
    assert b"Travel scheduled successfully" in resp.data


def test_add_schedule_invalid_type(client):
    login(client, "jdoe", "password")
    resp = client.post("/instructor/schedule", data={
        "schedule_type": "invalid",
        "start_date": "2026-03-01",
        "end_date": "2026-03-05",
    }, follow_redirects=True)
    assert b"Invalid schedule type" in resp.data


def test_add_schedule_missing_dates(client):
    login(client, "jdoe", "password")
    resp = client.post("/instructor/schedule", data={
        "schedule_type": "leave",
        "start_date": "",
        "end_date": "",
    }, follow_redirects=True)
    assert b"Start and end dates are required" in resp.data


def test_activity_log_records_status_change(client):
    login(client, "jdoe", "password")
    client.post("/instructor/status", data={"status": "Out"})
    resp = client.get("/instructor")
    assert b"Status changed" in resp.data
    assert b"Changed from In to Out" in resp.data


def test_index_redirects_to_login(client):
    resp = client.get("/")
    assert resp.status_code == 302
    assert "/login" in resp.headers["Location"]


def test_index_redirects_to_select_when_logged_in(client):
    login(client, "student", "password")
    resp = client.get("/")
    assert resp.status_code == 302
    assert "/select" in resp.headers["Location"]
