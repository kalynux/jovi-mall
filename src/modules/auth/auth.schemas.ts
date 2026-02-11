import { z } from 'zod';

export const RegisterSchema = z.object({
  phone: z.string().min(10, "Phone number required"),
  email: z.string().email("Invalid email").optional(),
  name: z.string().min(2, "Name required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  role: z.enum(['customer', 'vendor', 'agency', 'agent', 'admin']).default('customer'),
  business_name: z.string().optional(), // For vendors/agencies
  agency_name: z.string().optional(), // For agencies
});

export const LoginSchema = z.object({
  identifier: z.string().min(1, "Phone or Email required"),
  password: z.string().min(1, "Password required"),
  role: z.enum(['customer', 'vendor', 'agency', 'agent', 'admin']).optional(),
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
