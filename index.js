import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import bcrypt from "bcrypt";
import session from "express-session";
import passport from "passport";
import { Strategy } from "passport-local";
import env from "dotenv";
import {dirname} from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;
const saltRounds = 10;
env.config();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

app.use(
  session({
    secret: process.env.SECRET0,
    resave: false,
    saveUninitialized: true,
    cookie: {
      maxAge: 1000 * 60,
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

const db = new pg.Client({
  // user: process.env.SECRET1,
  // host: process.env.SECRET2,
  // database: process.env.SECRET3,
  // password: process.env.SECRET4,
  // port: process.env.SECRET5,
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});
db.connect();

app.get("/", (req, res) => {
  res.sendFile(__dirname+ "/public/HTML/home_page.html");
});

app.get("/login_as", (req, res) => {
  res.sendFile(__dirname+"/public/HTML/login_page.html");
});

app.get("/login_doctor", (req, res)=>{
    res.sendFile(__dirname+ "/public/HTML/login_doctor.html");
});

app.get("/login_patient", (req, res)=>{
    res.sendFile(__dirname+ "/public/HTML/login_patient.html");
});

app.get("/register", (req, res) => {
  res.sendFile(__dirname+ "/public/HTML/registration_page.html");
});

app.get("/register_doctor", (req, res)=>{
    res.sendFile(__dirname+ "/public/HTML/register_doctor.html");
});

app.get("/register_patient", (req, res)=>{
    res.sendFile(__dirname+ "/public/HTML/register_patient.html");
});

app.get("/logout", (req, res, next) => {
  req.logout(function(err) {
    if (err) { 
      return next(err); 
    }
    res.redirect("/");
  });
});

app.get("/patient_main_page", async (req, res) => {
  // First, check if the user is authenticated
  if (req.isAuthenticated()) {
    
    // Check if the user is a patient (by checking for an 'address' property, which only patients have)
    // This is safer than just assuming.
    if (!req.user.address) {
        // This is a doctor, send them to their dashboard
        return res.redirect("/doctor_main_page");
    }

    try {
      const patientId = req.user.id;
      const patientEmail = req.user.email;

      // 1. Get Patient's First Name
      const patientResult = await db.query("SELECT f_name FROM patient WHERE id = $1", [patientId]);
      const f_name = patientResult.rows[0].f_name;

      // 2. Get Doctor Directory List
      const doctorResult = await db.query(
        "SELECT id AS doctor_id, f_name || ' ' || l_name AS full_name, specialization FROM doctor"
      );
      const doctors = doctorResult.rows;

      // 3. Get Patient's Upcoming Appointments
      const appointmentResult = await db.query(
        `SELECT 
          a.appointment_time, 
          t2.id AS doctor_id, 
          t2.f_name || ' ' || t2.l_name AS doctor_name, 
          t2.specialization, 
          t2.contact_no AS contact_info
        FROM appointments a
        JOIN doctor t2 ON a.doctor_id = t2.id
        WHERE a.patient_id = $1 AND a.appointment_time >= NOW()
        ORDER BY a.appointment_time ASC`,
        [patientId]
      );
      const appointments = appointmentResult.rows;

      // 4. Render the page with all the data
      res.render("patient_main_page.ejs", {
        f_name: f_name,
        doctors: doctors,
        appointments: appointments,
      });

    } catch (err) {
      console.log(err);
      res.redirect("/login_patient");
    }
  } else {
    // If not authenticated, send to login
    res.redirect("/login_patient");
  }
});

// REPLACE your old /doctor_main_page route with this one
app.get("/doctor_main_page", async (req, res) => {
  // 1. Check if user is logged in
  if (req.isAuthenticated()) {
    
    // 2. Check if the user is a DOCTOR
    if (!req.user.specialization) {
      return res.redirect("/patient_main_page");
    }

    try {
      const doctorId = req.user.id;
      const doctorName = req.user.f_name;

      // 3. Get appointments for TODAY
      const todaysAppointmentsResult = await db.query(
        `SELECT
            a.appointment_time,
            t3.f_name || ' ' || t3.l_name AS patient_name
         FROM appointments a
         JOIN patient t3 ON a.patient_id = t3.id
         WHERE a.doctor_id = $1 AND a.appointment_time::date = CURRENT_DATE
         ORDER BY a.appointment_time ASC`,
        [doctorId]
      );
      const todaysAppointments = todaysAppointmentsResult.rows;
      
      // 4. Get all FUTURE appointments (after today)
      const upcomingAppointmentsResult = await db.query(
        `SELECT
            a.appointment_time,
            t3.f_name || ' ' || t3.l_name AS patient_name
         FROM appointments a
         JOIN patient t3 ON a.patient_id = t3.id
         WHERE a.doctor_id = $1 AND a.appointment_time::date > CURRENT_DATE
         ORDER BY a.appointment_time ASC`,
        [doctorId]
      );
      const upcomingAppointments = upcomingAppointmentsResult.rows;

      // 5. Render the page with BOTH lists
      res.render("doctor_main_page.ejs", {
        f_name: doctorName,
        todaysAppointments: todaysAppointments,       // <-- Note new name
        upcomingAppointments: upcomingAppointments   // <-- Note new list
      });

    } catch (err) {
      console.log(err);
      res.redirect("/login_doctor");
    }

  } else {
    // 6. If not logged in, send to login page
    res.redirect("/login_doctor");
  }
});

app.post("/book-appointment", async (req, res) => {
  // First, check if a patient is logged in
  if (!req.isAuthenticated() || !req.user.address) {
    // If not a patient (no address) or not logged in, redirect
    return res.redirect("/login_patient");
  }

  try {
    // 1. Get all the data
    const patientId = parseInt(req.user.id);
    const doctorId = parseInt(req.body.doctor_id);
    const date = req.body.appointment_date; // e.g., "2025-10-28"
    const time = req.body.appointment_time; // e.g., "14:30"

    // 2. Combine date and time into a single string
    const fullTimestamp = `${date} ${time}:00`; // e.g., "2025-10-28 14:30:00"

    // 3. Insert into the database
    await db.query(
      "INSERT INTO appointments (patient_id, doctor_id, appointment_time) VALUES ($1, $2, $3)",
      [patientId, doctorId, fullTimestamp]
    );

    // 4. Redirect back to the dashboard
    res.redirect("/patient_main_page");

  } catch (err) {
    console.log("Error booking appointment:", err);
    res.redirect("/patient_main_page"); // Send them back even if it fails
  }
});

app.post("/register_doctor", async (req, res) => {
  const f_name = req.body.first_name;
  const l_name = req.body.last_name;
  const specialization = req.body.specialization;
  const contact_no = req.body.contact_number;
  const email = req.body.email;
  const password = req.body.password;

  try {
    const checkResult = await db.query("SELECT * FROM doctor WHERE email = $1", [
      email,
    ]);

    if (checkResult.rows.length > 0) {
      res.send("Email already exists. Try logging in.");
    } else {
      //hashing the password and saving it in the database
      bcrypt.hash(password, saltRounds, async (err, hash) => {
        if (err) {
          console.error("Error hashing password:", err);
        } else {
          console.log(f_name);
          console.log(l_name);
          console.log(specialization);
          console.log(contact_no);
          console.log(email);
          console.log("Hashed Password:", hash);
            await db.query(
                "INSERT INTO doctor (f_name, l_name, specialization, contact_no, email, password) VALUES ($1, $2, $3, $4, $5, $6)",
                [f_name, l_name, specialization, contact_no, email, hash]             
          );
          res.redirect("/login_doctor");
        }
      });
    }
  } catch (err) {
    console.log(err);
  }
});

app.post("/register_patient", async (req, res) => {
    const f_name = req.body.first_name;
    const l_name = req.body.last_name;
    const age = req.body.age;
    const contact_no = req.body.contact_number;
    const address = req.body.address;
    const email = req.body.email;
    const password = req.body.password;
  
    try {
      const checkResult = await db.query("SELECT * FROM patient WHERE email = $1", [
        email,
      ]);
  
      if (checkResult.rows.length > 0) {
        res.send("Email already exists. Try logging in.");
      } else {
        //hashing the password and saving it in the database
        bcrypt.hash(password, saltRounds, async (err, hash) => {
          if (err) {
            console.error("Error hashing password:", err);
          } else {
            console.log(f_name);
            console.log(l_name);
            console.log(age);
            console.log(contact_no);
            console.log(address);
            console.log(email);
            console.log("Hashed Password:", hash);
              await db.query(
                  "INSERT INTO patient (f_name, l_name, age, contact_no, address, email, password) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                  [f_name, l_name, age, contact_no, address, email, hash]             
            );
            res.redirect("/login_patient");
          }
        });
      }
    } catch (err) {
      console.log(err);
    }
  });

app.post("/login_doctor", passport.authenticate("local-doctor", {
  successRedirect: "/doctor_main_page",
  failureRedirect: "/login_as",
}));

passport.use("local-doctor",
    new Strategy({ usernameField: 'email' }, async function verify(email, password, cb) {
  console.log(email);

  try {
    const result = await db.query("SELECT * FROM doctor WHERE email = $1", [
      email,
    ]);
    if (result.rows.length > 0) {
      const user = result.rows[0];
      const storedHashedPassword = user.password;
      bcrypt.compare(password, storedHashedPassword, (err, result) => {
        if (err) {
          return cb(err);
        } else {
          if (result) {
            return cb(null, user);
          } else {
            return cb(null, false);
          }
        }
      });
    } else {
      return cb("User not found");
    }
  } catch (err) {
    return cb(err);
  }
}));

app.post("/login_patient", passport.authenticate("local-patient", {
    successRedirect: "/patient_main_page",
    failureRedirect: "/login_as",
  }));
  
  passport.use("local-patient",
    new Strategy({ usernameField: 'email' }, async function verify(email, password, cb) {
    console.log(email);
  
    try {
      const result = await db.query("SELECT * FROM patient WHERE email = $1", [
        email,
      ]);
      if (result.rows.length > 0) {
        const user = result.rows[0];
        const storedHashedPassword = user.password;
        bcrypt.compare(password, storedHashedPassword, (err, result) => {
          if (err) {
            return cb(err);
          } else {
            if (result) {
              return cb(null, user);
            } else {
              return cb(null, false);
            }
          }
        });
      } else {
        return cb("User not found");
      }
    } catch (err) {
      return cb(err);
    }
  }));

passport.serializeUser((user, cb) => {
  cb(null, user);
});

passport.deserializeUser((user, cb) => {
  cb(null, user);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
