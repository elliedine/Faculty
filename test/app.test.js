'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const request = require('supertest');

// Use a temporary database for each test run
const tmpDb = path.join(os.tmpdir(), `faculty_test_${process.pid}.db`);
process.env.DATABASE = tmpDb;

const { app, initDb, seedDb } = require('../app');

beforeAll(() => {
  initDb();
  seedDb();
});

afterAll(() => {
  if (fs.existsSync(tmpDb)) {
    fs.unlinkSync(tmpDb);
  }
});

// Helper: create an agent that maintains cookies (session)
function makeAgent() {
  return request.agent(app);
}

async function login(agent, username, password) {
  return agent.post('/login').send(`username=${username}&password=${password}`).set('Content-Type', 'application/x-www-form-urlencoded');
}

describe('Faculty Locator – Node.js', () => {
  test('GET /login renders the login page', async () => {
    const res = await request(app).get('/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Sign In');
    expect(res.text).toContain('Faculty Locator');
  });

  test('POST /login succeeds for student and redirects to /select', async () => {
    const agent = makeAgent();
    const res = await login(agent, 'student', 'password');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/select');
  });

  test('GET /select shows STUDENT after login', async () => {
    const agent = makeAgent();
    await login(agent, 'student', 'password');
    const res = await agent.get('/select');
    expect(res.status).toBe(200);
    expect(res.text).toContain('STUDENT');
  });

  test('GET /select shows INSTRUCTOR for instructor role', async () => {
    const agent = makeAgent();
    await login(agent, 'jdoe', 'password');
    const res = await agent.get('/select');
    expect(res.status).toBe(200);
    expect(res.text).toContain('INSTRUCTOR');
  });

  test('POST /login fails with bad credentials', async () => {
    const res = await request(app)
      .post('/login')
      .send('username=bad&password=credentials')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    expect(res.status).toBe(302);
    const agent = makeAgent();
    const res2 = await agent
      .post('/login')
      .send('username=bad&password=credentials')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .redirects(1);
    expect(res2.text).toContain('Invalid username or password');
  });

  test('GET /logout redirects to login', async () => {
    const agent = makeAgent();
    await login(agent, 'student', 'password');
    const res = await agent.get('/logout').redirects(1);
    expect(res.text).toContain('Sign In');
  });

  test('GET /select requires login', async () => {
    const res = await request(app).get('/select');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login');
  });

  test('GET /student shows departments', async () => {
    const agent = makeAgent();
    await login(agent, 'student', 'password');
    const res = await agent.get('/student');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Departments');
    expect(res.text).toContain('CCS');
    expect(res.text).toContain('College of Computing Studies');
    expect(res.text).toContain('COE');
  });

  test('GET /student/department/1 shows instructors', async () => {
    const agent = makeAgent();
    await login(agent, 'student', 'password');
    const res = await agent.get('/student/department/1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('John Doe');
    expect(res.text).toContain('Anna Smith');
  });

  test('GET /student/department/1 shows status badges', async () => {
    const agent = makeAgent();
    await login(agent, 'student', 'password');
    const res = await agent.get('/student/department/1');
    expect(res.text).toContain('In');
    expect(res.text).toContain('Out');
  });

  test('GET /student/department/999 shows not found flash', async () => {
    const agent = makeAgent();
    await login(agent, 'student', 'password');
    const res = await agent.get('/student/department/999').redirects(1);
    expect(res.text).toContain('Department not found');
  });

  test('GET /instructor shows instructor dashboard', async () => {
    const agent = makeAgent();
    await login(agent, 'jdoe', 'password');
    const res = await agent.get('/instructor');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Instructor Dashboard');
    expect(res.text).toContain('John Doe');
    expect(res.text).toContain('My Status');
    expect(res.text).toContain('Activity Log');
  });

  test('GET /instructor is denied for student', async () => {
    const agent = makeAgent();
    await login(agent, 'student', 'password');
    const res = await agent.get('/instructor').redirects(1);
    expect(res.text).toContain('Access denied');
  });

  test('POST /instructor/status updates status', async () => {
    const agent = makeAgent();
    await login(agent, 'jdoe', 'password');
    const res = await agent
      .post('/instructor/status')
      .send('status=Out')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .redirects(1);
    expect(res.text).toContain('Status updated to Out');
    expect(res.text).toContain('Out');
  });

  test('POST /instructor/status rejects invalid status', async () => {
    const agent = makeAgent();
    await login(agent, 'jdoe', 'password');
    const res = await agent
      .post('/instructor/status')
      .send('status=Invalid')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .redirects(1);
    expect(res.text).toContain('Invalid status');
  });

  test('POST /instructor/schedule adds a leave', async () => {
    const agent = makeAgent();
    await login(agent, 'jdoe', 'password');
    const res = await agent
      .post('/instructor/schedule')
      .send('schedule_type=leave&start_date=2026-03-01&end_date=2026-03-05&reason=Personal+leave')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .redirects(1);
    expect(res.text).toContain('Leave scheduled successfully');
    expect(res.text).toContain('Personal leave');
  });

  test('POST /instructor/schedule adds a travel', async () => {
    const agent = makeAgent();
    await login(agent, 'jdoe', 'password');
    const res = await agent
      .post('/instructor/schedule')
      .send('schedule_type=travel&start_date=2026-04-01&end_date=2026-04-03&reason=Conference')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .redirects(1);
    expect(res.text).toContain('Travel scheduled successfully');
  });

  test('POST /instructor/schedule rejects invalid type', async () => {
    const agent = makeAgent();
    await login(agent, 'jdoe', 'password');
    const res = await agent
      .post('/instructor/schedule')
      .send('schedule_type=invalid&start_date=2026-03-01&end_date=2026-03-05')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .redirects(1);
    expect(res.text).toContain('Invalid schedule type');
  });

  test('POST /instructor/schedule requires dates', async () => {
    const agent = makeAgent();
    await login(agent, 'jdoe', 'password');
    const res = await agent
      .post('/instructor/schedule')
      .send('schedule_type=leave&start_date=&end_date=')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .redirects(1);
    expect(res.text).toContain('Start and end dates are required');
  });

  test('Activity log records status change', async () => {
    const agent = makeAgent();
    await login(agent, 'jdoe', 'password');
    await agent
      .post('/instructor/status')
      .send('status=Out')
      .set('Content-Type', 'application/x-www-form-urlencoded');
    const res = await agent.get('/instructor');
    expect(res.text).toContain('Status changed');
    expect(res.text).toContain('Changed from');
    expect(res.text).toContain('to Out');
  });

  test('GET / redirects to /login when not logged in', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/login');
  });

  test('GET / redirects to /select when logged in', async () => {
    const agent = makeAgent();
    await login(agent, 'student', 'password');
    const res = await agent.get('/');
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('/select');
  });
});
