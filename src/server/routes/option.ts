import * as express from "express";
import config from "../../config";
export const router = express.Router();

router.get("/", async (req: express.Request, res: express.Response) => {
  res.json({
    ENABLE_DOWNLOAD: config.ENABLE_DOWNLOAD,
    MAX_FILE_SIZE: config.MAX_FILE_SIZE,
    MAX_REPO_SIZE: config.MAX_REPO_SIZE,
    ANONYMIZATION_MASK: config.ANONYMIZATION_MASK,
  });
});

export default router;
