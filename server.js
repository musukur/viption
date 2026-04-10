import express from "express";

const app = express();

app.use(express.json());

// simple test route
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "API is working"
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
