import { describe, expect, it } from 'vitest';
import { ASTParser } from '../ast-parser';

describe('ASTParser', () => {
  it('correctly parses classes, methods, functions, interfaces, and imports', () => {
    const code = `
      import { ExtensionContext, window } from 'vscode';
      import * as fs from 'fs';
      const path = require('path');

      export interface User {
        id: string;
        name: string;
      }

      export class UserService {
        private users: User[] = [];

        constructor() {}

        public getUser(id: string): User | undefined {
          return this.users.find(u => u.id === id);
        }
      }

      export function formatUser(user: User): string {
        return user.name;
      }

      export const deleteUser = (id: string) => {
        console.log("deleting user", id);
      };
    `;

    const result = ASTParser.parse('test-file.ts', code);

    // Assert nodes
    const types = result.nodes.map(n => n.type);
    expect(types).toContain('class');
    expect(types).toContain('method');
    expect(types).toContain('interface');
    expect(types).toContain('function');

    const userService = result.nodes.find(n => n.name === 'UserService');
    expect(userService).toBeDefined();
    expect(userService!.type).toBe('class');
    expect(userService!.signature).toBe('export class UserService');

    const getUserMethod = result.nodes.find(n => n.name === 'UserService.getUser');
    expect(getUserMethod).toBeDefined();
    expect(getUserMethod!.type).toBe('method');
    expect(getUserMethod!.signature).toBe('public getUser(id: string): User | undefined');

    const interfaceUser = result.nodes.find(n => n.name === 'User');
    expect(interfaceUser).toBeDefined();
    expect(interfaceUser!.type).toBe('interface');
    expect(interfaceUser!.signature).toBe('export interface User');

    const formatUserFunc = result.nodes.find(n => n.name === 'formatUser');
    expect(formatUserFunc).toBeDefined();
    expect(formatUserFunc!.type).toBe('function');
    expect(formatUserFunc!.signature).toBe('export function formatUser(user: User): string');

    const deleteUserFunc = result.nodes.find(n => n.name === 'deleteUser');
    expect(deleteUserFunc).toBeDefined();
    expect(deleteUserFunc!.type).toBe('function');
    expect(deleteUserFunc!.signature).toContain('deleteUser = (id: string) =>');

    // Assert relations
    const relationTargets = result.relations.map(r => r.targetName);
    expect(relationTargets).toContain('ExtensionContext');
    expect(relationTargets).toContain('window');
    expect(relationTargets).toContain('fs');
    expect(relationTargets).toContain('path');
    expect(relationTargets).toContain('UserService.getUser');
  });
});
