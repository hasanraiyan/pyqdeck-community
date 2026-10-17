import { cloudinaryDescriptor } from "./cloudinary.provider.js";
import { memoryDescriptor } from "./memory.provider.js";
import { ProviderRegistry } from "./provider.registry.js";

/**
 * The one place that lists available providers. To add UploadThing later: write `uploadthing.provider.ts`
 * exporting a descriptor, then add one `.register(...)` line here.
 */
export function createDefaultRegistry(options: { allowMemory: boolean }): ProviderRegistry {
  const registry = new ProviderRegistry().register(cloudinaryDescriptor);
  if (options.allowMemory) registry.register(memoryDescriptor);
  return registry;
}
