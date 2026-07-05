import { describe, expect, it } from 'vitest';
import { ASTParser } from '../ast-parser';

describe('ASTParser Multi-Language Support', () => {
  it('correctly parses Python files', () => {
    const code = `
import os
from sys import argv

class Calculator(BaseCalc):
    def __init__(self):
        pass

    def add_nums(self, a, b):
        return a + b

def calculate_total(x):
    return x * 10
`;
    const result = ASTParser.parse('test.py', code);

    // Nodes
    const classNode = result.nodes.find(n => n.name === 'Calculator');
    expect(classNode).toBeDefined();
    expect(classNode!.type).toBe('class');
    expect(classNode!.signature).toBe('class Calculator(BaseCalc)');

    const methodNode = result.nodes.find(n => n.name === 'Calculator.add_nums');
    expect(methodNode).toBeDefined();
    expect(methodNode!.type).toBe('method');
    expect(methodNode!.signature).toBe('def add_nums(self, a, b)');

    const funcNode = result.nodes.find(n => n.name === 'calculate_total');
    expect(funcNode).toBeDefined();
    expect(funcNode!.type).toBe('function');
    expect(funcNode!.signature).toBe('def calculate_total(x)');

    // Relations
    const imports = result.relations.filter(r => r.relationType === 'IMPORTS').map(r => r.targetName);
    expect(imports).toContain('os');
    expect(imports).toContain('sys');

    const defines = result.relations.filter(r => r.relationType === 'DEFINES').map(r => r.targetName);
    expect(defines).toContain('Calculator.add_nums');
  });

  it('correctly parses Go files', () => {
    const code = `
package main

import (
\t"fmt"
\t"os"
)

type Worker struct {
\tid int
}

type Processor interface {
\tProcess() error
}

func (w *Worker) DoWork(task string) error {
\treturn nil
}

func RunProcessor(p Processor) {
\tfmt.Println("Running")
}
`;
    const result = ASTParser.parse('main.go', code);

    // Nodes
    const structNode = result.nodes.find(n => n.name === 'Worker');
    expect(structNode).toBeDefined();
    expect(structNode!.type).toBe('class');
    expect(structNode!.signature).toBe('type Worker struct');

    const interfaceNode = result.nodes.find(n => n.name === 'Processor');
    expect(interfaceNode).toBeDefined();
    expect(interfaceNode!.type).toBe('interface');
    expect(interfaceNode!.signature).toBe('type Processor interface');

    const methodNode = result.nodes.find(n => n.name === 'Worker.DoWork');
    expect(methodNode).toBeDefined();
    expect(methodNode!.type).toBe('method');
    expect(methodNode!.signature).toBe('func (w *Worker) DoWork(task string) error');

    const funcNode = result.nodes.find(n => n.name === 'RunProcessor');
    expect(funcNode).toBeDefined();
    expect(funcNode!.type).toBe('function');
    expect(funcNode!.signature).toBe('func RunProcessor(p Processor)');

    // Relations
    const imports = result.relations.filter(r => r.relationType === 'IMPORTS').map(r => r.targetName);
    expect(imports).toContain('fmt');
    expect(imports).toContain('os');
  });

  it('correctly parses Rust files', () => {
    const code = `
use std::collections::HashMap;

struct User {
    username: String,
}

trait Authenticatable {
    fn authenticate(&self) -> bool;
}

impl User {
    fn new(username: &str) -> Self {
        User { username: username.to_string() }
    }
}

async fn run_system() -> Result<(), Error> {
    Ok(())
}
`;
    const result = ASTParser.parse('lib.rs', code);

    // Nodes
    const structNode = result.nodes.find(n => n.name === 'User');
    expect(structNode).toBeDefined();
    expect(structNode!.type).toBe('class');
    expect(structNode!.signature).toBe('struct User');

    const traitNode = result.nodes.find(n => n.name === 'Authenticatable');
    expect(traitNode).toBeDefined();
    expect(traitNode!.type).toBe('interface');
    expect(traitNode!.signature).toBe('trait Authenticatable');

    const methodNode = result.nodes.find(n => n.name === 'User.new');
    expect(methodNode).toBeDefined();
    expect(methodNode!.type).toBe('method');
    expect(methodNode!.signature).toBe('fn new(username: &str) -> Self');

    const funcNode = result.nodes.find(n => n.name === 'run_system');
    expect(funcNode).toBeDefined();
    expect(funcNode!.type).toBe('function');
    expect(funcNode!.signature).toBe('async fn run_system() -> Result<(), Error>');

    // Relations
    const imports = result.relations.filter(r => r.relationType === 'IMPORTS').map(r => r.targetName);
    expect(imports).toContain('std::collections::HashMap');
  });

  it('correctly parses Java files', () => {
    const code = `
import java.util.List;

public class DatabaseManager {
    private List<String> connections;

    public void connect(String url) throws SQLException {
        System.out.println("Connecting");
    }
}
`;
    const result = ASTParser.parse('DatabaseManager.java', code);

    // Nodes
    const classNode = result.nodes.find(n => n.name === 'DatabaseManager');
    expect(classNode).toBeDefined();
    expect(classNode!.type).toBe('class');
    expect(classNode!.signature).toBe('public class DatabaseManager');

    const methodNode = result.nodes.find(n => n.name === 'DatabaseManager.connect');
    expect(methodNode).toBeDefined();
    expect(methodNode!.type).toBe('method');
    expect(methodNode!.signature).toBe('public void connect(String url) throws SQLException');

    // Relations
    const imports = result.relations.filter(r => r.relationType === 'IMPORTS').map(r => r.targetName);
    expect(imports).toContain('java.util.List');
  });
});
