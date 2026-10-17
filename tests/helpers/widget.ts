/**
 * A throwaway feature module that follows the project's layered pattern.
 * It exists only to exercise the base repository/service/controller and middleware end to end.
 */
import { Router } from "express";
import { Schema, model } from "mongoose";
import { z } from "zod";
import { BaseController } from "../../src/core/base/BaseController.js";
import { BaseRepository } from "../../src/core/base/BaseRepository.js";
import { BaseService } from "../../src/core/base/BaseService.js";
import { validate } from "../../src/core/middleware/validate.js";
import { paginationQuerySchema } from "../../src/core/utils/pagination.js";
import healthRoutes from "../../src/modules/health/health.routes.js";

export interface IWidget {
  name: string;
  qty: number;
  category: string;
}

export const WidgetModel = model<IWidget>(
  "Widget",
  new Schema<IWidget>(
    {
      name: { type: String, required: true, unique: true, trim: true },
      qty: { type: Number, required: true, min: 0 },
      category: { type: String, required: true },
    },
    { timestamps: true },
  ),
);

class WidgetRepository extends BaseRepository<IWidget> {
  constructor() {
    super(WidgetModel);
  }
}

class WidgetService extends BaseService<IWidget, WidgetRepository> {
  constructor() {
    super(new WidgetRepository(), "Widget");
  }
}

class WidgetController extends BaseController<IWidget, WidgetService> {
  constructor() {
    super(new WidgetService());
  }
}

const createSchema = z.object({ name: z.string().min(1), qty: z.number().int().min(0), category: z.string().min(1) });
const idParam = z.object({ id: z.string().min(1) });
const listQuery = paginationQuerySchema.extend({ category: z.string().optional() });

const controller = new WidgetController();
const widgets = Router();
widgets.get("/", validate({ query: listQuery }), controller.list);
widgets.post("/", validate({ body: createSchema }), controller.create);
widgets.get("/:id", validate({ params: idParam }), controller.getById);
widgets.patch("/:id", validate({ params: idParam, body: createSchema.partial() }), controller.update);
widgets.delete("/:id", validate({ params: idParam }), controller.delete);

export const testRoutes = Router();
testRoutes.use("/health", healthRoutes);
testRoutes.use("/widgets", widgets);
