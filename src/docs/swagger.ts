import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import { openApiSpec } from "./openapi.js";

const router = Router();

router.get("/json", (_req, res) => {
  res.json(openApiSpec);
});
router.use("/", swaggerUi.serve, swaggerUi.setup(openApiSpec));

export default router;
