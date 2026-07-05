import * as ts from 'typescript';
import * as path from 'path';
import * as fs from 'fs';

export interface ASTNodeInfo {
  name: string;
  type: 'class' | 'interface' | 'function' | 'method';
  signature: string;
  content: string;
  startLine: number;
  endLine: number;
}

export interface ASTRelationInfo {
  targetName: string;
  relationType: 'IMPORTS' | 'CALLS' | 'DEFINES';
}

export interface ASTParseResult {
  nodes: ASTNodeInfo[];
  relations: ASTRelationInfo[];
}

export class ASTParser {
  public static parse(filePath: string, content: string): ASTParseResult {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.py') {
      return this.parsePython(filePath, content);
    } else if (ext === '.go') {
      return this.parseGo(filePath, content);
    } else if (ext === '.rs') {
      return this.parseRust(filePath, content);
    } else if (ext === '.java') {
      return this.parseJava(filePath, content);
    } else {
      return this.parseTypeScript(filePath, content);
    }
  }

  private static parseTypeScript(filePath: string, content: string): ASTParseResult {
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true
    );

    const nodes: ASTNodeInfo[] = [];
    const relations: ASTRelationInfo[] = [];

    const getLines = (node: ts.Node) => {
      const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
      return { start, end };
    };

    const getSignatureText = (node: ts.Node, name: string): string => {
      const text = node.getText(sourceFile);
      const braceIndex = text.indexOf('{');
      if (braceIndex !== -1) {
        return text.substring(0, braceIndex).trim();
      }
      const arrowIndex = text.indexOf('=>');
      if (arrowIndex !== -1 && (node.kind === ts.SyntaxKind.VariableDeclaration || node.kind === ts.SyntaxKind.PropertyAssignment)) {
        return text.substring(0, arrowIndex + 2).trim();
      }
      return text.trim();
    };

    const getVariableStatementText = (node: ts.VariableDeclaration): { text: string; start: number; end: number } => {
      let current: ts.Node = node;
      while (current.parent && !ts.isVariableStatement(current)) {
        current = current.parent;
      }
      if (current && ts.isVariableStatement(current)) {
        const { start, end } = getLines(current);
        return { text: current.getText(sourceFile), start, end };
      }
      const { start, end } = getLines(node);
      return { text: node.getText(sourceFile), start, end };
    };

    const visit = (node: ts.Node) => {
      if (ts.isClassDeclaration(node) && node.name) {
        const className = node.name.text;
        const { start, end } = getLines(node);
        nodes.push({
          name: className,
          type: 'class',
          signature: getSignatureText(node, className),
          content: node.getText(sourceFile),
          startLine: start,
          endLine: end
        });

        node.members.forEach(member => {
          if (ts.isMethodDeclaration(member) && member.name) {
            const methodName = member.name.getText(sourceFile);
            const { start: mStart, end: mEnd } = getLines(member);
            nodes.push({
              name: `${className}.${methodName}`,
              type: 'method',
              signature: getSignatureText(member, methodName),
              content: member.getText(sourceFile),
              startLine: mStart,
              endLine: mEnd
            });
            relations.push({
              targetName: `${className}.${methodName}`,
              relationType: 'DEFINES'
            });
          }
        });
      }

      if (ts.isInterfaceDeclaration(node) && node.name) {
        const interfaceName = node.name.text;
        const { start, end } = getLines(node);
        nodes.push({
          name: interfaceName,
          type: 'interface',
          signature: getSignatureText(node, interfaceName),
          content: node.getText(sourceFile),
          startLine: start,
          endLine: end
        });
      }

      if (ts.isFunctionDeclaration(node) && node.name) {
        const funcName = node.name.text;
        const { start, end } = getLines(node);
        nodes.push({
          name: funcName,
          type: 'function',
          signature: getSignatureText(node, funcName),
          content: node.getText(sourceFile),
          startLine: start,
          endLine: end
        });
      }

      if (ts.isVariableDeclaration(node) && node.name && node.initializer) {
        const isFunction = ts.isArrowFunction(node.initializer) ||
                           ts.isFunctionExpression(node.initializer);
        if (isFunction) {
          const varName = node.name.getText(sourceFile);
          const varStmt = getVariableStatementText(node);
          nodes.push({
            name: varName,
            type: 'function',
            signature: `${node.name.getText(sourceFile)} = ${getSignatureText(node.initializer, varName)}`,
            content: varStmt.text,
            startLine: varStmt.start,
            endLine: varStmt.end
          });
        }
      }

      if (ts.isImportDeclaration(node)) {
        if (node.importClause) {
          if (node.importClause.name) {
            relations.push({
              targetName: node.importClause.name.text,
              relationType: 'IMPORTS'
            });
          }
          if (node.importClause.namedBindings) {
            if (ts.isNamedImports(node.importClause.namedBindings)) {
              node.importClause.namedBindings.elements.forEach(element => {
                relations.push({
                  targetName: element.name.text,
                  relationType: 'IMPORTS'
                });
              });
            } else if (ts.isNamespaceImport(node.importClause.namedBindings)) {
              relations.push({
                targetName: node.importClause.namedBindings.name.text,
                relationType: 'IMPORTS'
              });
            }
          }
        }
      }

      if (ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'require' &&
          node.arguments.length === 1 &&
          ts.isStringLiteral(node.arguments[0])) {
        let parentNode = node.parent;
        if (ts.isVariableDeclaration(parentNode) && parentNode.name) {
          relations.push({
            targetName: parentNode.name.getText(sourceFile),
            relationType: 'IMPORTS'
          });
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sourceFile);

    return { nodes, relations };
  }

  private static parsePython(filePath: string, content: string): ASTParseResult {
    const nodes: ASTNodeInfo[] = [];
    const relations: ASTRelationInfo[] = [];
    const lines = content.split(/\r?\n/);
    
    let currentClass: string | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;
      
      const classMatch = line.match(/^\s*class\s+(\w+)(?:\(([^)]+)\))?:/);
      if (classMatch) {
        currentClass = classMatch[1];
        nodes.push({
          name: currentClass,
          type: 'class',
          signature: classMatch[0].trim().replace(/:$/, ''),
          content: line,
          startLine: lineNum,
          endLine: lineNum
        });
        continue;
      }
      
      const defMatch = line.match(/^(\s*)def\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?:/);
      if (defMatch) {
        const indent = defMatch[1].length;
        const name = defMatch[2];
        const args = defMatch[3];
        const returnType = defMatch[4] ? ` -> ${defMatch[4].trim()}` : '';
        const sig = `def ${name}(${args})${returnType}`;
        
        if (indent > 0 && currentClass) {
          const fullName = `${currentClass}.${name}`;
          nodes.push({
            name: fullName,
            type: 'method',
            signature: sig,
            content: line,
            startLine: lineNum,
            endLine: lineNum
          });
          relations.push({
            targetName: fullName,
            relationType: 'DEFINES'
          });
        } else {
          currentClass = null;
          nodes.push({
            name: name,
            type: 'function',
            signature: sig,
            content: line,
            startLine: lineNum,
            endLine: lineNum
          });
        }
        continue;
      }
      
      const importMatch = line.match(/^\s*(?:import\s+(\w+)|from\s+(\w+)\s+import)/);
      if (importMatch) {
        const name = importMatch[1] || importMatch[2];
        relations.push({
          targetName: name,
          relationType: 'IMPORTS'
        });
      }
    }
    
    return { nodes, relations };
  }

  private static parseGo(filePath: string, content: string): ASTParseResult {
    const nodes: ASTNodeInfo[] = [];
    const relations: ASTRelationInfo[] = [];
    const lines = content.split(/\r?\n/);
    
    let inImportBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Handle Go import blocks
      if (line.includes('import (')) {
        inImportBlock = true;
        continue;
      }
      if (inImportBlock && line.includes(')')) {
        inImportBlock = false;
        continue;
      }

      if (inImportBlock) {
        const singleImportMatch = line.match(/^\s*"([^"]+)"/);
        if (singleImportMatch) {
          relations.push({ targetName: singleImportMatch[1], relationType: 'IMPORTS' });
        }
        continue;
      }

      // Single line import
      const singleImportMatch = line.match(/^\s*import\s+"([^"]+)"/);
      if (singleImportMatch) {
        relations.push({ targetName: singleImportMatch[1], relationType: 'IMPORTS' });
        continue;
      }

      // Struct/Interface Match
      const typeMatch = line.match(/^\s*type\s+(\w+)\s+(struct|interface)/);
      if (typeMatch) {
        const name = typeMatch[1];
        const type = typeMatch[2] === 'struct' ? 'class' : 'interface';
        nodes.push({
          name,
          type,
          signature: line.trim().replace(/\s*\{?\s*$/, ''),
          content: line,
          startLine: lineNum,
          endLine: lineNum
        });
        continue;
      }

      // Method Match: func (r *Receiver) Method(...)
      const methodMatch = line.match(/^\s*func\s*\(\s*(?:\w+\s+)?\*?(\w+)\s*\)\s*(\w+)\s*\(([^)]*)\)([^{]*)/);
      if (methodMatch) {
        const receiver = methodMatch[1];
        const name = methodMatch[2];
        const fullName = `${receiver}.${name}`;
        nodes.push({
          name: fullName,
          type: 'method',
          signature: line.trim().replace(/\s*\{?\s*$/, ''),
          content: line,
          startLine: lineNum,
          endLine: lineNum
        });
        relations.push({
          targetName: fullName,
          relationType: 'DEFINES'
        });
        continue;
      }

      // Function Match: func Name(...)
      const funcMatch = line.match(/^\s*func\s+(\w+)\s*\(([^)]*)\)([^{]*)/);
      if (funcMatch) {
        const name = funcMatch[1];
        nodes.push({
          name,
          type: 'function',
          signature: line.trim().replace(/\s*\{?\s*$/, ''),
          content: line,
          startLine: lineNum,
          endLine: lineNum
        });
        continue;
      }
    }

    return { nodes, relations };
  }

  private static parseRust(filePath: string, content: string): ASTParseResult {
    const nodes: ASTNodeInfo[] = [];
    const relations: ASTRelationInfo[] = [];
    const lines = content.split(/\r?\n/);
    
    let currentImpl: string | null = null;
    let braceDepth = 0;
    let implStartDepth = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Track brace depth
      const openCount = (line.match(/\{/g) || []).length;
      const closeCount = (line.match(/\}/g) || []).length;
      
      const prevDepth = braceDepth;
      braceDepth = braceDepth + openCount - closeCount;

      // Check if we exited current impl block
      if (currentImpl !== null && braceDepth <= implStartDepth) {
        currentImpl = null;
        implStartDepth = -1;
      }

      // Impl block tracking
      const implMatch = line.match(/^\s*impl(?:\s+[\w<>,]+?\s+for)?\s+(\w+)/);
      if (implMatch) {
        currentImpl = implMatch[1];
        implStartDepth = prevDepth;
        continue;
      }

      // Struct/Enum/Trait Match
      const structMatch = line.match(/^\s*(?:pub\s+)?(?:struct|enum|union)\s+(\w+)/);
      if (structMatch) {
        const name = structMatch[1];
        nodes.push({
          name,
          type: 'class',
          signature: line.trim().replace(/\s*\{?\s*$/, ''),
          content: line,
          startLine: lineNum,
          endLine: lineNum
        });
        continue;
      }

      const traitMatch = line.match(/^\s*(?:pub\s+)?trait\s+(\w+)/);
      if (traitMatch) {
        const name = traitMatch[1];
        nodes.push({
          name,
          type: 'interface',
          signature: line.trim().replace(/\s*\{?\s*$/, ''),
          content: line,
          startLine: lineNum,
          endLine: lineNum
        });
        continue;
      }

      // Function/Method Match
      const fnMatch = line.match(/^\s*(?:pub\s+)?(?:const\s+|async\s+)*fn\s+(\w+)\s*\(([^)]*)\)(?:\s*->\s*([^{]+))?/);
      if (fnMatch) {
        const name = fnMatch[1];
        const sig = line.trim().replace(/\s*\{?\s*$/, '');

        if (currentImpl) {
          const fullName = `${currentImpl}.${name}`;
          nodes.push({
            name: fullName,
            type: 'method',
            signature: sig,
            content: line,
            startLine: lineNum,
            endLine: lineNum
          });
          relations.push({
            targetName: fullName,
            relationType: 'DEFINES'
          });
        } else {
          nodes.push({
            name,
            type: 'function',
            signature: sig,
            content: line,
            startLine: lineNum,
            endLine: lineNum
          });
        }
        continue;
      }

      // Rust use/import Match
      const useMatch = line.match(/^\s*use\s+([\w::]+)/);
      if (useMatch) {
        relations.push({
          targetName: useMatch[1],
          relationType: 'IMPORTS'
        });
      }
    }

    return { nodes, relations };
  }

  private static parseJava(filePath: string, content: string): ASTParseResult {
    const nodes: ASTNodeInfo[] = [];
    const relations: ASTRelationInfo[] = [];
    const lines = content.split(/\r?\n/);
    
    let currentClass: string | null = null;
    let braceDepth = 0;
    let classStartDepth = -1;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      const openCount = (line.match(/\{/g) || []).length;
      const closeCount = (line.match(/\}/g) || []).length;
      
      const prevDepth = braceDepth;
      braceDepth = braceDepth + openCount - closeCount;

      if (currentClass !== null && braceDepth <= classStartDepth) {
        currentClass = null;
        classStartDepth = -1;
      }

      // Class Match
      const classMatch = line.match(/^\s*(?:public|private|protected|static|\s)*class\s+(\w+)/);
      if (classMatch) {
        currentClass = classMatch[1];
        classStartDepth = prevDepth;
        nodes.push({
          name: currentClass,
          type: 'class',
          signature: line.trim().replace(/\s*\{?\s*$/, ''),
          content: line,
          startLine: lineNum,
          endLine: lineNum
        });
        continue;
      }

      const interfaceMatch = line.match(/^\s*(?:public|private|protected|static|\s)*interface\s+(\w+)/);
      if (interfaceMatch) {
        const name = interfaceMatch[1];
        nodes.push({
          name,
          type: 'interface',
          signature: line.trim().replace(/\s*\{?\s*$/, ''),
          content: line,
          startLine: lineNum,
          endLine: lineNum
        });
        continue;
      }

      // Method Match
      const methodMatch = line.match(/^\s*(?:public|protected|private|static|final|synchronized|\s)+([\w<>[\]]+)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w,\s]+)?\s*\{?/);
      if (methodMatch) {
        const returnType = methodMatch[1];
        const name = methodMatch[2];
        
        if (!['if', 'for', 'while', 'switch', 'catch'].includes(name)) {
          const sig = line.trim().replace(/\s*\{?\s*$/, '');
          if (currentClass) {
            const fullName = `${currentClass}.${name}`;
            nodes.push({
              name: fullName,
              type: 'method',
              signature: sig,
              content: line,
              startLine: lineNum,
              endLine: lineNum
            });
            relations.push({
              targetName: fullName,
              relationType: 'DEFINES'
            });
          } else {
            nodes.push({
              name,
              type: 'function',
              signature: sig,
              content: line,
              startLine: lineNum,
              endLine: lineNum
            });
          }
        }
        continue;
      }

      const importMatch = line.match(/^\s*import\s+([\w.]+);/);
      if (importMatch) {
        relations.push({
          targetName: importMatch[1],
          relationType: 'IMPORTS'
        });
      }
    }

    return { nodes, relations };
  }

  public static async generateRepoMap(workspaceRoot: string): Promise<string> {
    if (!workspaceRoot) return '';
    const mapLines: string[] = [];
    const maxFiles = 60;
    let fileCount = 0;

    const scanDir = (dir: string) => {
      if (fileCount >= maxFiles) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      
      entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      for (const entry of entries) {
        if (fileCount >= maxFiles) break;
        const fullPath = path.join(dir, entry.name);
        
        if (entry.isDirectory()) {
          const ignoreDirs = ['node_modules', '.git', 'dist', 'out', 'build', '.next', '.k-horizon', 'bin', 'obj', 'vendor'];
          if (ignoreDirs.includes(entry.name)) continue;
          scanDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const supportedExts = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java'];
          if (!supportedExts.includes(ext)) continue;
          
          if (entry.name.includes('.test.') || entry.name.includes('.spec.') || dir.includes('tests') || dir.includes('__tests__')) {
            continue;
          }

          try {
            const content = fs.readFileSync(fullPath, 'utf8');
            const relativePath = path.relative(workspaceRoot, fullPath).replace(/\\/g, '/');
            const astResult = this.parse(fullPath, content);
            
            if (astResult.nodes.length > 0) {
              fileCount++;
              mapLines.push(`\n=== File: ${relativePath} ===`);
              
              const classes = astResult.nodes.filter(n => n.type === 'class' || n.type === 'interface');
              const globals = astResult.nodes.filter(n => n.type === 'function' && !n.name.includes('.'));
              
              classes.forEach(c => {
                mapLines.push(`${c.type} ${c.name}`);
                const methods = astResult.nodes.filter(n => n.type === 'method' && n.name.startsWith(`${c.name}.`));
                methods.forEach(m => {
                  const shortMethodName = m.name.substring(c.name.length + 1);
                  mapLines.push(`  - method ${shortMethodName}: ${m.signature}`);
                });
              });
              
              globals.forEach(g => {
                mapLines.push(`function ${g.name}: ${g.signature}`);
              });
            }
          } catch (e) {
            // Ignore unreadable files
          }
        }
      }
    };

    try {
      scanDir(workspaceRoot);
      if (mapLines.length === 0) return '';
      
      const header = `## Codebase Repository Map (High-level symbol signatures to help you navigate context)\n`;
      let mapStr = mapLines.join('\n');
      
      if (mapStr.length > 25000) {
        mapStr = mapStr.substring(0, 25000) + '\n\n... [Repository Map truncated for token efficiency]';
      }
      return header + mapStr;
    } catch (err) {
      console.error('[ASTParser] Failed to generate repo map:', err);
      return '';
    }
  }
}
