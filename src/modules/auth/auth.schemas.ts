import { z } from 'zod';

export const RegisterSchema = z.object({
  phone: z.string().min(10, "Phone number required"),
  email: z.string().email("Invalid email").optional(),
  name: z.string().min(2, "Name required"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  role: z.enum(['customer', 'vendor', 'agency', 'agent', 'admin']).default('vendor'),
  business_name: z.string().optional(), // For vendors
  agency_name: z.string().optional(), // For agencies
});

export const LoginSchema = z.object({
  identifier: z.string().min(1, "Phone or Email required"),
  password: z.string().min(1, "Password required"),
  role: z.enum(['customer', 'vendor', 'agency', 'agent', 'admin']).optional(),
});

export const AuthMeSchema = z.object({
  userId: z.string().min(1, "User ID required"),
  role: z.enum(['customer', 'vendor', 'agency', 'agent', 'admin']),
});

export const AddRoleSchema = z.object({
  role: z.enum(['customer', 'vendor', 'agency', 'agent', 'admin']),
  name: z.string().min(2, 'Name required').optional(),          // customer / agent / admin
  business_name: z.string().optional(),                          // vendor
  agency_name: z.string().optional(),                            // agency
});

export type RegisterInput = z.infer<typeof RegisterSchema>;
export type LoginInput = z.infer<typeof LoginSchema>;
export type AuthMeInput = z.infer<typeof AuthMeSchema>;
export type AddRoleInput = z.infer<typeof AddRoleSchema>;
