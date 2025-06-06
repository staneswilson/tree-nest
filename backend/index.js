const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const path = require("path");
const moment = require("moment");
const multer = require("multer");
const momentTimezone = require("moment-timezone");
const {
  uploadImage,
  deleteImage,
  constructImageUrl,
} = require("./cloudinaryService");
const loadEnv = require("./loadEnv");
const calculateRoadDistance = require("./location");
const extractLatLngFromLink = require("./extractgmap");

const app = express();
const textToSpeech = require("@google-cloud/text-to-speech");
const client = new textToSpeech.TextToSpeechClient();

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../dist")));

const uri = process.env.MONGO_URI;
const GOOGLE_APPLICATION_CREDENTIALS =
  process.env.GOOGLE_APPLICATION_CREDENTIALS;

async function connectDB() {
  try {
    await mongoose.connect(uri, { dbName: process.env.DB_NAME });
    console.log("Connected to DB");
  } catch (err) {
    console.error(err);
  }
}

connectDB();

const storage = multer.memoryStorage();
const upload = multer({ storage });

const FamilyMemberSchema = new mongoose.Schema({
  name: { type: String, required: true },
  dob: { type: Date },
  phone: { type: String },
  image: { type: String }, // Store image file name from Cloudinary
  occupation: { type: String },
  address: { type: String },
  spouse: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "FamilyMember",
    default: null,
  },
  children: [{ type: mongoose.Schema.Types.ObjectId, ref: "FamilyMember" }],
  location: {
    coordinates: {
      type: [Number], // [longitude, latitude]
      required: false,
    },
  },
  about: { type: String },
});

const FamilyMember = mongoose.model("FamilyMember", FamilyMemberSchema);

app.get("/healthcheck", (req, res) => {
  res.status(200).send("OK");
});

app.get("/api/members", async (req, res) => {
  try {
    const members = await FamilyMember.find().populate("spouse children");

    const membersWithDetails = members.map((member) => {
      const location =
        member.location?.coordinates?.length === 2
          ? `https://www.google.com/maps?q=${member.location.coordinates[1]},${member.location.coordinates[0]}`
          : null;

      return {
        ...member.toObject(),
        image: member.image ? constructImageUrl(member.image) : null,
        location: location,
      };
    });

    res.json(membersWithDetails);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.get("/api/members/:id", async (req, res) => {
  try {
    let member = await FamilyMember.findById(req.params.id).populate(
      "spouse children"
    );
    if (!member) return res.status(404).json({ message: "Member not found" });
    if (!member.spouse) {
      const parent = await FamilyMember.findOne({
        children: req.params.id,
      }).populate("spouse children");
      member = parent;
    }

    const location =
      member.location?.coordinates?.length === 2
        ? `https://www.google.com/maps?q=${member.location.coordinates[1]},${member.location.coordinates[0]}`
        : null;

    const memberWithDetails = {
      ...member.toObject(),
      image: member.image ? constructImageUrl(member.image) : null,
      location: location, // Add the location link
    };

    res.json(memberWithDetails);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

app.post("/api/members", upload.single("image"), async (req, res) => {
  try {
    const {
      name,
      dob,
      phone,
      occupation,
      address,
      spouse,
      parent,
      children,
      location,
      about,
    } = req.body;
    const parsedDob = moment(dob, "DD/MM/YYYY").toDate();
    if (!parsedDob || isNaN(parsedDob)) throw new Error("Invalid date format");

    let imageFileName = "";
    if (req.file) {
      imageFileName = await uploadImage(req.file.buffer, req.file.originalname);
    }

    let coordinates = [];
    if (location) {
      const extractedLocation = await extractLatLngFromLink(location);
      coordinates = [extractedLocation.lng, extractedLocation.lat];
    }

    const newMember = new FamilyMember({
      name,
      dob: parsedDob,
      phone,
      image: imageFileName,
      occupation,
      address,
      spouse,
      children: children ? children.split(",") : [],
      location: { coordinates },
      about,
    });
    await newMember.save();

    if (spouse) {
      await FamilyMember.findByIdAndUpdate(spouse, {
        $addToSet: { children: { $each: newMember.children } },
        spouse: newMember._id,
        image: imageFileName,
        about: about,
      });
    }
    if (parent) {
      await FamilyMember.findByIdAndUpdate(parent, {
        $addToSet: { children: newMember._id },
      });
    }

    res.status(201).json(newMember);
  } catch (err) {
    console.error(err);
    res.status(400).json({ message: err.message });
  }
});

app.put("/api/members/:id", upload.single("image"), async (req, res) => {
  try {
    const {
      name,
      dob,
      phone,
      occupation,
      address,
      spouse,
      parent,
      children,
      location,
      about,
      deleteOldImage, // Expecting 'true' or 'false' (as strings from form-data) or undefined
    } = req.body;

    const memberToUpdate = await FamilyMember.findById(req.params.id);
    if (!memberToUpdate) {
      return res.status(404).json({ message: "Member not found" });
    }

    const oldImageName = memberToUpdate.image;

    if (name !== undefined) memberToUpdate.name = name;
    if (dob !== undefined) {
      const parsedDob = moment(dob, "DD/MM/YYYY").toDate();
      if (!parsedDob || isNaN(parsedDob.getTime())) {
        return res.status(400).json({ message: "Invalid date format for DOB. Please use DD/MM/YYYY." });
      }
      memberToUpdate.dob = parsedDob;
    }
    if (phone !== undefined) memberToUpdate.phone = phone;
    if (occupation !== undefined) memberToUpdate.occupation = occupation;
    if (address !== undefined) memberToUpdate.address = address;
    if (about !== undefined) memberToUpdate.about = about;

    // Handle image update logic
    if (req.file) {
      try {
        const uploadedImagePublicId = await uploadImage(req.file.buffer, req.file.originalname);
        memberToUpdate.image = uploadedImagePublicId;

        if (oldImageName && oldImageName !== uploadedImagePublicId && deleteOldImage !== 'false') {
          await deleteImage(oldImageName);
        }
      } catch (uploadError) {
        console.error("Error during image upload:", uploadError);
        return res.status(500).json({ message: `Image upload failed: ${uploadError.message}` });
      }
    } else { 
      if (deleteOldImage === 'true' && oldImageName) {
        try {
          await deleteImage(oldImageName);
          memberToUpdate.image = null;
        } catch (deleteError) {
          console.error(`Failed to delete image ${oldImageName}:`, deleteError);
          return res.status(500).json({ message: `Failed to delete image: ${deleteError.message}` });
        }
      }
    }

    // Update location
    if (location === '') {
        memberToUpdate.location = { coordinates: [] };
    } else if (location) {
      try {
        const extractedLocation = await extractLatLngFromLink(location);
        if (extractedLocation && typeof extractedLocation.lat === 'number' && typeof extractedLocation.lng === 'number') {
            memberToUpdate.location = { coordinates: [extractedLocation.lng, extractedLocation.lat] };
        } else {
            console.warn("Could not extract valid coordinates from location link for update:", location);
        }
      } catch (error) {
        console.error("Error extracting location for update:", error);
      }
    }

    let savedMember = await memberToUpdate.save();

    const currentSpouseId = savedMember.spouse ? savedMember.spouse.toString() : null;
    const newSpouseId = (spouse && mongoose.Types.ObjectId.isValid(spouse.trim())) ? spouse.trim() : null;
    
    if (currentSpouseId !== newSpouseId) {
      if (currentSpouseId) {
        await FamilyMember.findByIdAndUpdate(currentSpouseId, { spouse: null });
      }
      if (newSpouseId) {
        await FamilyMember.findByIdAndUpdate(newSpouseId, { spouse: savedMember._id, image: savedMember.image });
        savedMember.spouse = newSpouseId;
      } else {
        savedMember.spouse = null;
      }
      savedMember = await savedMember.save();
    }

    if (children !== undefined) {
      let newChildrenIds = [];
      if (typeof children === 'string' && children.trim() !== '') {
        newChildrenIds = children.split(',').map(id => id.trim()).filter(id => mongoose.Types.ObjectId.isValid(id));
      } else if (Array.isArray(children)) {
        newChildrenIds = children.map(id => String(id).trim()).filter(id => mongoose.Types.ObjectId.isValid(id));
      } else if (children === '' || (Array.isArray(children) && children.length === 0)) {
        newChildrenIds = [];
      }
      savedMember.children = newChildrenIds;
      savedMember = await savedMember.save();
    }

    if (parent && mongoose.Types.ObjectId.isValid(parent.trim())) {
      await FamilyMember.findByIdAndUpdate(parent.trim(), { $addToSet: { children: savedMember._id } });
    }

    const finalUpdatedMember = await FamilyMember.findById(savedMember._id).populate('spouse children');
    res.json(finalUpdatedMember);

  } catch (err) {
    console.error("Error updating member:", err);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ message: err.message, errors: err.errors });
    }
    res.status(500).json({ message: err.message });
  }
});

app.delete("/api/members/:id", async (req, res) => {
  try {
    const deletedMember = await FamilyMember.findByIdAndDelete(req.params.id);
    if (!deletedMember)
      return res.status(404).json({ message: "Member not found" });
    if (deletedMember.spouse)
      await FamilyMember.findByIdAndUpdate(deletedMember.spouse, {
        $pull: { children: deletedMember._id },
        $unset: { spouse: "" },
      });
    await FamilyMember.updateMany(
      { children: deletedMember._id },
      { $pull: { children: deletedMember._id } }
    );
    // Delete image from Cloudinary if image file name exists
    if (deletedMember.image) {
      try {
        await deleteImage(deletedMember.image);
      } catch (cloudinaryErr) {
        console.error("Error deleting image from Cloudinary:", cloudinaryErr);
      }
    }
    res.json(deletedMember);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

app.get("/api/search", async (req, res) => {
  try {
    const { query } = req.query;
    const searchRegex = new RegExp(query, "i");
    const members = await FamilyMember.find({
      $or: [
        { name: searchRegex },
        { phone: searchRegex },
        { occupation: searchRegex },
        { address: searchRegex },
      ],
    }).populate("spouse children");
    // Generate full URLs for images
    const membersWithUrls = members.map((member) => ({
      ...member.toObject(),
      image: member.image ? constructImageUrl(member.image) : null,
    }));
    res.json(membersWithUrls);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

app.get("/api/nearby", async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) {
    return res
      .status(400)
      .json({ message: "Latitude and longitude are required" });
  }
  try {
    const members = await FamilyMember.find();
    const nearbyMembers = await Promise.all(
      members.map(async (member) => {
        if (
          !member.location ||
          !member.location.coordinates ||
          member.location.coordinates.length !== 2
        )
          return null; // Skip members without valid coordinates
        const [lon, lat] = member.location.coordinates;
        const distanceResponse = await calculateRoadDistance(
          parseFloat(lat),
          parseFloat(lng),
          lat,
          lon
        );
        // Extract numeric distance from the response
        const distance = parseFloat(distanceResponse);
        // Return the member only if the distance is valid
        if (distance != null && !isNaN(distance)) {
          return { ...member.toObject(), distance };
        }
        return null; // Skip members with invalid distance
      })
    );
    const validMembers = nearbyMembers
      .filter((member) => member !== null) // Filter out nulls (invalid members)
      .sort((a, b) => a.distance - b.distance) // Sort by distance (closest first)
      .map((member) => {
        if (member.image) {
          member.image = constructImageUrl(member.image);
        }
        return member;
      });
    res.json(validMembers);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Error fetching nearby family members" });
  }
});

app.get("/api/members/birthdays/today", async (req, res) => {
  try {
    const today = momentTimezone().tz("Asia/Kolkata");
    const todayDay = today.date();
    const todayMonth = today.month() + 1; // Months are 0-indexed in JS
    const birthdays = await FamilyMember.aggregate([
      {
        $project: {
          name: 1,
          dob: 1,
          image: 1,
          day: { $dayOfMonth: "$dob" },
          month: { $month: "$dob" },
        },
      },
      {
        $match: {
          day: todayDay,
          month: todayMonth,
        },
      },
    ]);
    // Add image URLs and format dates
    const formattedBirthdays = birthdays.map((member) => ({
      ...member,
      image: member.image ? constructImageUrl(member.image) : null,
      dob: moment(member.dob).format("DD-MM-YYYY"), // Format for frontend
    }));
    res.json(formattedBirthdays);
  } catch (error) {
    console.error("Birthday error:", error);
    res.status(500).json({ message: "Error fetching birthdays" });
  }
});

app.post("/api/tts", async (req, res) => {
  try {
    const { text, languageCode } = req.body; // e.g., languageCode: 'ml-IN' for Malayalam
    const request = {
      input: { text },
      voice: { languageCode, ssmlGender: "NEUTRAL" },
      audioConfig: { audioEncoding: "MP3" },
    };
    const [response] = await client.synthesizeSpeech(request);
    // Set the response content type and send the audio content
    res.set("Content-Type", "audio/mpeg");
    res.send(response.audioContent);
  } catch (error) {
    console.error("Error generating TTS:", error);
    res.status(500).send("Error generating TTS");
  }
});

app.get("*", (req, res) =>
  res.sendFile(path.join(__dirname, "../dist/index.html"))
);
app.listen(5000, () => console.log("Server is running on port 5000"));
