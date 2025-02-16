const User = require("../models/User");
const Event = require("../models/Event");
const RSVP = require("../models/RSVPs");
const mongoose = require("mongoose");

async function getAllEvents(req, res) {
    const userId = req.session.user ? req.session.user.uid : null;  // Check if user is logged in
    const events = await Event.find({});

    const user = userId ? await User.findById(userId).exec() : null;  // Only fetch user if logged in

    res.locals.user = user; // Available in all views

    // Modify each event to include a formatted date and calculate open spaces
    events.forEach(event => {
        event.formattedDate = new Date(event.eventDate).toDateString();

        // Calculate open spaces
        event.openSpaces = event.maxAttendees - event.rsvps.length;
    });

    // Render the page and pass events along with user and openSpaces
    res.render("user/events", { user, events });
}

async function getEvent(req, res) {
    const userId = req.session.user ? req.session.user.uid : null;  // Check if user is logged in
    const eventId = req.params.eventId;   // Get eventId from the request parameters

    const user = userId ? await User.findById(userId).exec() : null;  // Only fetch user if logged in

    res.locals.user = user; // Available in all views

    const event = await Event.findById(eventId).exec();  // Fetch the event by ID

    if (!event) {
        return res.status(404).send("Event not found");  // Handle event not found scenario
    }

    event.formattedDate = new Date(event.eventDate).toDateString();  // Format the event date

    const calculateAverageRating = (ratings) => {
        if (ratings.length === 0) return 0;
        const sum = ratings.reduce((total, r) => total + r.rating, 0);
        return (sum / ratings.length).toFixed(1); // Round to 1 decimal place
    }

    event.averageRating = calculateAverageRating(event.ratings);

    const isRSVPed = user ? event.rsvps.includes(userId) : false; // Only check RSVP if user is logged in

    res.render("user/event-details", { user, event, isRSVPed });  // Passing the event to the view
}


async function toggleRSVP(req, res) {
    const userId = req.session.user ? req.session.user.uid : null;
    if (!userId) {
        return res.status(401).json({ error: "User not authenticated" });
    }

    const eventId = req.params.eventId;
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
        const event = await Event.findById(eventId).session(session);
        if (!event) {
            await session.abortTransaction();
            session.endSession();
            return res.status(404).json({ error: "Event not found" });
        }

        // Prevent RSVP changes if event has started
        const eventStartTime = new Date(event.eventDate);
        if (new Date() >= eventStartTime) {
            await session.abortTransaction();
            session.endSession();
            return res.status(400).json({ error: "RSVP changes are not allowed after the event starts" });
        }

        const hasRSVPed = event.rsvps.includes(userId);

        if (hasRSVPed) {
            // Cancel RSVP (atomic)
            const updateResult = await Event.findOneAndUpdate(
                { _id: eventId },
                { $pull: { rsvps: userId } },
                { new: true, session }
            );

            // Ensure the user was actually removed
            if (!updateResult.rsvps.includes(userId)) {
                await RSVP.deleteOne({ userId, eventId }, { session });

                await session.commitTransaction();
                session.endSession();
                return res.json({ message: "RSVP cancelled successfully", isRSVPed: false });
            } else {
                await session.abortTransaction();
                session.endSession();
                return res.status(500).json({ error: "Failed to cancel RSVP" });
            }
        } else {
            // Prevent RSVP if event is full
            if (event.rsvps.length >= event.maxAttendees) {
                await session.abortTransaction();
                session.endSession();
                return res.status(400).json({ error: "Event is full" });
            }

            // Add RSVP (atomic)
            await Event.findOneAndUpdate(
                { _id: eventId },
                { $push: { rsvps: userId } },
                { session }
            );
            await RSVP.create([{ userId, eventId }], { session });

            await session.commitTransaction();
            session.endSession();
            return res.json({ message: "RSVP confirmed successfully", isRSVPed: true });
        }
    } catch (error) {
        await session.abortTransaction();
        session.endSession();
        console.error("RSVP Error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
}

async function eventRating(req, res) {
    const userId = req.session.user?.uid;  // Ensure user is logged in
    if (!userId) return res.status(401).json({ error: "User not authenticated" });

    const { rating, comment } = req.body;
    const { eventId } = req.params;

    try {
        const event = await Event.findById(eventId);
        if (!event) return res.status(404).json({ error: "Event not found" });

        // Prevent duplicate ratings from the same user
        const existingRating = event.ratings.find(r => r.user.toString() === userId);
        if (existingRating) {
            return res.status(400).json({ error: "You have already rated this event" });
        }

        event.ratings.push({ user: userId, rating, comment });
        await event.save();

        res.status(201).redirect('/events/own');
    } catch (error) {
        console.error("Rating Error:", error);
        res.status(500).json({ error: "Internal server error" });
    }
}

async function getUserRSVPs(req, res) {
    try {
        const userId = req.session.user ? req.session.user.uid : null;
        if (!userId) {
            return res.redirect("/auth/user/signin");
        }

        // Fetch events where user has RSVP'd
        const rsvpEvents = await Event.find({ rsvps: userId })
            .populate("rsvps", "fullName email")
            .populate("ratings.user", "fullName email");

        res.render("user/user-events", { events: rsvpEvents });
    } catch (error) {
        console.error("Error fetching RSVP'd events:", error);
        res.status(500).send("Error fetching your RSVP'd events.");
    }
}

module.exports = { getAllEvents, getEvent, toggleRSVP, eventRating, getUserRSVPs };  // Exporting the functions to be used in routes