const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const mysql = require('mysql2/promise'); // <--- IMPORTANT: Using mysql2/promise for async/await
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// --- Database connection pool ---
// Use mysql2/promise.createPool for promise-based operations
const pool = mysql.createPool({ // <--- 'pool' is now defined here
    host: 'localhost',
    user: 'root',
    password: '', // <--- Set your MySQL password here
    database: 'event_management',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Test database connection
pool.getConnection()
    .then(connection => {
        console.log('Successfully connected to the MySQL database using pool!');
        connection.release(); // Release the connection
    })
    .catch(err => {
        console.error('Error connecting to the database pool:', err.message);
        process.exit(1); // Exit the process if database connection fails
    });

// --- ROUTES ---

// User Signup
app.post('/signup', async (req, res) => { // Added async
    const { first_name, last_name, email, phone, password } = req.body;

    const insertUser = `
        INSERT INTO users (first_name, last_name, email, phone, password)
        VALUES (?, ?, ?, ?, ?)
    `;

    try {
        await pool.execute(insertUser, [first_name, last_name, email, phone, password]); // Using pool.execute
        res.send("User signup successful");
    } catch (err) {
        console.error("Signup DB error:", err);
        res.status(500).send("Error inserting user");
    }
});

// User Login
app.post('/login', async (req, res) => { // Added async
    const { email, password } = req.body;
    try {
        const [results] = await pool.execute("SELECT * FROM users WHERE email = ?", [email]); // Using pool.execute
        if (results.length === 0) return res.status(401).send("Invalid login");

        const user = results[0];
        // IMPORTANT: For production, use bcrypt.compare(password, user.password) here
        if (password === user.password) { // Plaintext comparison for now
            res.send({ message: "Login successful", user: user });
        } else {
            res.status(401).send("Incorrect password");
        }
    } catch (err) {
        console.error("Login DB error:", err);
        res.status(500).send("Server error");
    }
});

// Admin Login
app.post("/login-admin", async (req, res) => { // Added async
    const { username, password } = req.body;

    const query = "SELECT * FROM admins WHERE username = ?";
    try {
        const [results] = await pool.execute(query, [username]); // Using pool.execute
        if (results.length === 0) return res.status(401).send("Unauthorized");

        const admin = results[0];
        // IMPORTANT: For production, use bcrypt.compare(password, admin.password) here
        if (password !== admin.password) { // Plaintext comparison for now
            return res.status(401).send("Unauthorized");
        }

        res.json({ id: admin.id, username: admin.username });
    } catch (err) {
        console.error("Admin Login DB error:", err);
        res.status(500).send("Server error");
    }
});

// Get all events
app.get('/events', async (req, res) => { // Added async
    try {
        const [results] = await pool.execute("SELECT * FROM events"); // Using pool.execute
        res.json(results);
    } catch (err) {
        console.error("Fetch events error:", err);
        res.status(500).send(err);
    }
});

// Create new event
app.post('/events', async (req, res) => {
    const {
        userId,
        name,
        description,
        categoryId,
        venueId,
        startDate,
        endDate,
        startTime,
        endTime,
        organizerId,
        vendorId,
        visibility,
        maxAttendees,
        ticketPrice,
        budget
    } = req.body;

    if (!userId || !name || !description || !categoryId || !venueId || !startDate || !endDate || !startTime || !endTime || !organizerId || !visibility) {
        return res.status(400).json({ message: 'Missing required event fields.' });
    }

    try {
        const [result] = await pool.execute( // Using pool.execute
            `INSERT INTO events (user_id, name, description, category_id, venue_id, start_date, end_date, start_time, end_time, organizer_id, vendor_id, visibility, max_attendees, ticket_price, budget)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                userId,
                name,
                description,
                categoryId,
                venueId,
                startDate,
                endDate,
                startTime,
                endTime,
                organizerId,
                vendorId || null,
                visibility,
                maxAttendees || null,
                ticketPrice || null,
                budget || null
            ]
        );

        res.status(201).json({ message: 'Event created successfully!', eventId: result.insertId });
    } catch (error) {
        console.error('Error creating event:', error);
        if (error.code === 'ER_NO_REFERENCED_ROW_2') {
            return res.status(400).json({ message: 'Invalid category, venue, organizer, or vendor ID. Please ensure these IDs exist in your database.' });
        }
        res.status(500).json({ message: 'Internal server error: Database insert failed.', details: error.message });
    }
});


// Get all events for a specific user, with payment status
app.get('/events/user/:userId', async (req, res) => {
    const { userId } = req.params;
    try {
        // This query now includes a LEFT JOIN with the payments table
        // to check if a payment exists for each event.
        const [rows] = await pool.execute(`
            SELECT 
                e.*,
                CASE WHEN p.event_id IS NOT NULL THEN TRUE ELSE FALSE END AS is_paid
            FROM events e
            LEFT JOIN payments p ON e.id = p.event_id
            WHERE e.user_id = ?
        `, [userId]);
        res.json(rows);
    } catch (err) {
        console.error('Error fetching user events:', err);
        res.status(500).json({ message: 'Error fetching user events' });
    }
});

// Get a single event by ID
app.get('/events/:id', async (req, res) => {
    const { id } = req.params;
    try {
        const [rows] = await pool.execute('SELECT * FROM events WHERE id = ?', [id]);
        if (rows.length === 0) {
            return res.status(404).json({ message: 'Event not found' });
        }
        res.json(rows[0]);
    } catch (err) {
        console.error('Error fetching event:', err);
        res.status(500).json({ message: 'Error fetching event' });
    }
});

// Update an event by ID
app.put('/events/:id', async (req, res) => {
    const { id } = req.params;
    const {
        name, description, categoryId, venueId, startDate, endDate, startTime, endTime,
        organizerId, vendorId, visibility, maxAttendees, ticketPrice, budget
    } = req.body;

    // Validate that required fields are present
    if (!name || !description || !categoryId || !venueId || !startDate || !endDate || !startTime || !endTime || !organizerId || !visibility) {
        return res.status(400).json({ message: 'Please provide all required event details.' });
    }

    try {
        const [result] = await pool.execute(
            'UPDATE events SET name = ?, description = ?, category_id = ?, venue_id = ?, start_date = ?, end_date = ?, start_time = ?, end_time = ?, organizer_id = ?, vendor_id = ?, visibility = ?, max_attendees = ?, ticket_price = ?, budget = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            [name, description, categoryId, venueId, startDate, endDate, startTime, endTime, organizerId, vendorId, visibility, maxAttendees, ticketPrice, budget, id]
        );
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Event not found or no changes made.' });
        }

        res.status(200).json({ message: 'Event updated successfully.' });

    } catch (err) {
        console.error('Error updating event:', err);
        res.status(500).json({ message: 'Failed to update event' });
    }
});

// Delete event
app.delete('/events/:id', async (req, res) => { // Added async
    try {
        await pool.execute("DELETE FROM events WHERE id = ?", [req.params.id]); // Using pool.execute
        res.send("Event deleted");
    } catch (err) {
        console.error("Delete event error:", err);
        res.status(500).send(err);
    }
});

// New POST route to handle payments for events
app.post("/payments", async (req, res) => {
    const { event_id, method, account_info, amount } = req.body;

    if (!event_id || !method || !account_info || !amount) {
        return res.status(400).json({ message: "Missing required payment information." });
    }

    try {
        // Optional: Validate if the event_id exists
        const [eventRows] = await pool.execute(
            `SELECT id FROM events WHERE id = ?`,
            [event_id]
        );

        if (eventRows.length === 0) {
            return res.status(404).json({ message: "Invalid event ID. Event not found." });
        }

        const [result] = await pool.execute(
            'INSERT INTO payments (event_id, method, account_info, amount) VALUES (?, ?, ?, ?)',
            [event_id, method, account_info, amount]
        );

        res.status(201).json({ message: 'Payment recorded successfully!', paymentId: result.insertId });

    } catch (err) {
        console.error('Error processing payment:', err);
        res.status(500).json({ message: 'Failed to process payment.', details: err.message });
    }
});

// New GET route to fetch a single payment by its ID, with event details
app.get("/payments/:id", async (req, res) => {
    const paymentId = req.params.id;

    try {
        const [rows] = await pool.execute(
            `SELECT 
                p.id, 
                p.amount, 
                p.transaction_date, 
                p.method, 
                p.account_info, 
                e.name AS event_name 
            FROM payments p
            JOIN events e ON p.event_id = e.id
            WHERE p.id = ?`,
            [paymentId]
        );

        if (rows.length === 0) {
            return res.status(404).json({ message: "Payment not found." });
        }

        res.status(200).json(rows[0]);

    } catch (err) {
        console.error('Error fetching payment details:', err);
        res.status(500).json({ message: 'Failed to retrieve payment details.', details: err.message });
    }
});


// GET all categories
app.get('/categories', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT id, name FROM categories');
        res.json(rows);
    } catch (error) {
        console.error('Error fetching categories:', error);
        res.status(500).json({ message: 'Error fetching categories.', details: error.message });
    }
});

// Get Venues
app.get('/venues', async (req, res) => {
    try {
        const [rows] = await pool.execute('SELECT id, name, location FROM venues');
        res.json(rows);
    } catch (error) {
        console.error('Error fetching venues:', error);
        res.status(500).json({ message: 'Error fetching venues.', details: error.message });
    }
});

// --- ADMIN DASHBOARD ROUTES ---

// Admin: Get all events with organizer names and payment status
app.get('/admin/events', async (req, res) => {
    try {
        const [rows] = await pool.execute(`
            SELECT
                e.*,
                CONCAT(o.first_name, ' ', o.last_name) AS organizer_name,
                CASE WHEN p.event_id IS NOT NULL THEN TRUE ELSE FALSE END AS is_paid,
                e.is_approved -- Ensure is_approved is selected
            FROM events e
            LEFT JOIN organizers o ON e.organizer_id = o.id
            LEFT JOIN payments p ON e.id = p.event_id
        `);
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching all events for admin:', err);
        res.status(500).json({ message: 'Failed to retrieve events.', details: err.message });
    }
});

// Admin: Get dashboard summary data
app.get('/admin/dashboard-summary', async (req, res) => {
    try {
        const [totalEvents] = await pool.execute('SELECT COUNT(*) AS count FROM events');
        const [totalUsers] = await pool.execute('SELECT COUNT(*) AS count FROM users');
        const [totalPayments] = await pool.execute('SELECT SUM(amount) AS total FROM payments');
        // Assuming you have a 'feedbacks' table. If not, remove this line or create the table.
        const [totalFeedbacks] = await pool.execute('SELECT COUNT(*) AS count FROM feedback'); // Changed to 'feedback' (singular)

        res.status(200).json({
            totalEvents: totalEvents[0].count,
            totalUsers: totalUsers[0].count,
            totalPayments: totalPayments[0].total || 0,
            totalFeedbacks: totalFeedbacks[0].count
        });
    } catch (err) {
        console.error('Error fetching dashboard summary:', err);
        res.status(500).json({ message: 'Failed to retrieve summary data.', details: err.message });
    }
});


// Admin: Get all vendors (dedicated admin route)
// This route was commented out in your provided code, now uncommented for admin dashboard
app.get('/admin/vendors', async (req, res) => {
    try {
        const [results] = await pool.execute('SELECT * FROM vendors');
        res.json(results);
    } catch (err) {
        console.error('Fetch vendors error:', err);
        res.status(500).send('Error fetching vendors'); // Consistent with your existing /vendors error handling
    }
});

// Admin: Add new vendor (existing logic, preserved response)
app.post('/admin/vendors', async (req, res) => {
    const { first_name, last_name, service, phone, email } = req.body;

    if (!first_name || !last_name || !email) {
        return res.status(400).send("First name, last name, and email are required");
    }

    const query = `
        INSERT INTO vendors (first_name, last_name, service, phone, email)
        VALUES (?, ?, ?, ?, ?)
    `;

    try {
        await pool.execute(query, [first_name, last_name, service, phone, email]);
        res.send("Vendor added");
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).send("Email already exists");
        }
        console.error('Insert vendor failed:', err);
        res.status(500).send("Insert failed");
    }
});

// Admin: Update vendor (existing logic, preserved response)
app.put('/admin/vendors/:id', async (req, res) => {
    const { first_name, last_name, service, phone, email } = req.body;

    if (!first_name || !last_name || !email) {
        return res.status(400).send("First name, last name, and email are required");
    }

    const query = `
        UPDATE vendors SET first_name=?, last_name=?, service=?, phone=?, email=? 
        WHERE id=?
    `;

    try {
        const [result] = await pool.execute(query, [first_name, last_name, service, phone, email, req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).send("Vendor not found."); // Added 404 for clarity
        }
        res.send("Vendor updated");
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).send("Email already exists");
        }
        console.error('Update vendor failed:', err);
        res.status(500).send("Update failed");
    }
});

// Admin: Delete vendor (existing logic, preserved response)
app.delete('/admin/vendors/:id', async (req, res) => {
    const vendorId = req.params.id;

    try {
        const [deleteResult] = await pool.execute("DELETE FROM vendors WHERE id=?", [vendorId]);

        if (deleteResult.affectedRows === 0) {
            return res.status(404).send("Vendor not found."); // Added 404 for clarity
        }

        const [results] = await pool.execute("SELECT COUNT(*) AS total FROM vendors");
        const total = results[0].total;

        if (total === 0) {
            await pool.execute("ALTER TABLE vendors AUTO_INCREMENT = 1");
            res.send("Vendor deleted and ID reset");
        } else {
            res.send("Vendor deleted");
        }
    } catch (err) {
        console.error('Delete vendor failed:', err);
        res.status(500).send("Delete failed");
    }
});


// Admin: Get all organizers (dedicated admin route)
// This is a new dedicated route for the admin dashboard
app.get('/admin/organizers', async (req, res) => {
    try {
        const [results] = await pool.execute('SELECT * FROM organizers');
        res.json(results);
    } catch (err) {
        console.error('Fetch organizers error:', err);
        res.status(500).send('Error fetching organizers'); // Consistent with your existing /organizers error handling
    }
});

// Admin: Add new organizer (existing logic, preserved response)
app.post('/admin/organizers', async (req, res) => {
    const { first_name, last_name, company, phone, email } = req.body;

    if (!first_name || !last_name || !email) {
        return res.status(400).send("First name, last name, and email are required");
    }

    const query = `
        INSERT INTO organizers (first_name, last_name, company, phone, email)
        VALUES (?, ?, ?, ?, ?)
    `;

    try {
        await pool.execute(query, [first_name, last_name, company, phone, email]);
        res.send("Organizer added");
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).send("Email already exists");
        }
        console.error('Insert organizer failed:', err);
        res.status(500).send("Insert failed");
    }
});

// Admin: Update organizer (existing logic, preserved response)
app.put('/admin/organizers/:id', async (req, res) => {
    const { first_name, last_name, company, phone, email } = req.body;

    if (!first_name || !last_name || !email) {
        return res.status(400).send("First name, last name, and email are required");
    }

    const query = `
        UPDATE organizers SET first_name=?, last_name=?, company=?, phone=?, email=? 
        WHERE id=?
    `;

    try {
        const [result] = await pool.execute(query, [first_name, last_name, company, phone, email, req.params.id]);
        if (result.affectedRows === 0) {
            return res.status(404).send("Organizer not found."); // Added 404 for clarity
        }
        res.send("Organizer updated");
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).send("Email already exists");
        }
        console.error('Update organizer failed:', err);
        res.status(500).send("Update failed");
    }
});

// Admin: Delete organizer (existing logic, preserved response)
app.delete('/admin/organizers/:id', async (req, res) => {
    const organizerId = req.params.id;

    try {
        const [deleteResult] = await pool.execute("DELETE FROM organizers WHERE id=?", [organizerId]);

        if (deleteResult.affectedRows === 0) {
            return res.status(404).send("Organizer not found."); // Added 404 for clarity
        }

        const [results] = await pool.execute("SELECT COUNT(*) AS total FROM organizers");
        const total = results[0].total;

        if (total === 0) {
            await pool.execute("ALTER TABLE organizers AUTO_INCREMENT = 1");
            res.send("Organizer deleted and ID reset");
        } else {
            res.send("Organizer deleted");
        }
    } catch (err) {
        console.error('Delete organizer failed:', err);
        res.status(500).send("Delete failed");
    }
});

// Admin: Approve a paid event
app.put('/admin/events/approve/:id', async (req, res) => {
    const eventId = req.params.id;
    try {
        const [result] = await pool.execute(
            'UPDATE events SET is_approved = TRUE WHERE id = ?',
            [eventId]
        );
        if (result.affectedRows === 0) {
            return res.status(404).send('Event not found.'); // Consistent response type
        }
        res.send('Event approved successfully!'); // Consistent response type
    } catch (err) {
        console.error('Error approving event:', err);
        res.status(500).send('Failed to approve event.'); // Consistent response type
    }
});

// Admin: Delete an event
app.delete('/admin/events/:id', async (req, res) => {
    const eventId = req.params.id;
    try {
        const [result] = await pool.execute('DELETE FROM events WHERE id = ?', [eventId]);
        if (result.affectedRows === 0) {
            return res.status(404).send('Event not found.'); // Consistent response type
        }
        res.send('Event deleted successfully!'); // Consistent response type
    } catch (err) {
        console.error('Error deleting event:', err);
        res.status(500).send('Failed to delete event.'); // Consistent response type
    }
});

// New route to handle feedback submission
app.post('/feedback', async (req, res) => {
    const { user_id, event_id, comment, rating } = req.body;

    if (!user_id || !rating) {
        return res.status(400).json({ message: 'Missing required feedback information (user_id, rating).' });
    }

    if (rating < 1 || rating > 5) {
        return res.status(400).json({ message: 'Rating must be between 1 and 5.' });
    }

    try {
        const [result] = await pool.execute(
            'INSERT INTO feedback (user_id, event_id, rating, comment) VALUES (?, ?, ?, ?)',
            [user_id, event_id || null, rating, comment]
        );

        res.status(201).json({ message: 'Feedback submitted successfully!', feedbackId: result.insertId });
    } catch (err) {
        console.error('Error submitting feedback:', err);
        res.status(500).json({ message: 'Failed to submit feedback.', details: err.message });
    }
});

// New GET route to fetch all payments for a specific user
app.get('/payments/user/:userId', async (req, res) => {
    const userId = req.params.userId;
    try {
        const [rows] = await pool.execute(
            `SELECT 
                p.id, 
                p.amount, 
                p.transaction_date, 
                p.method, 
                e.name AS event_name 
            FROM payments p
            JOIN events e ON p.event_id = e.id
            WHERE e.user_id = ? -- Assuming payments are made by the event creator for their own events
            ORDER BY p.transaction_date DESC`,
            [userId]
        );
        res.status(200).json(rows);
    } catch (err) {
        console.error('Error fetching user payments:', err);
        res.status(500).json({ message: 'Failed to retrieve user payments.', details: err.message });
    }
});
app.get('/organizers', async (req, res) => { 
    try { 
        const [results] = await pool.execute('SELECT * FROM organizers'); 
        res.json(results); 
    } catch (err) { 
        console.error('Fetch organizers error:', err); 
        res.status(500).send('Error fetching organizers'); 
    } 
}); 
app.get('/vendors', async (req, res) => { 
    try { 
        const [results] = await pool.execute('SELECT * FROM vendors'); 
        res.json(results); 
    } catch (err) { 
        console.error('Fetch vendors error:', err); 
        res.status(500).send('Error fetching vendors'); 
    } 
}); 

// Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
