# Contributing to Better Auth Firestore

Thank you for your interest in contributing to Better Auth Firestore. This guide will help you get started with the contribution process.

## Code of Conduct

This project and everyone participating in it is governed by our Code of Conduct. By participating, you are expected to uphold this code.

## Project Structure

The Better Auth Firestore project is organized as follows:

- `/src` - Source code for the Firestore adapter
- `/tests` - Test files and test configuration
- `/examples` - Example applications demonstrating usage
- `/dist` - Built output (generated, do not edit directly)

## Development Guidelines

When contributing to Better Auth Firestore:

- Keep changes focused. Large PRs are harder to review and unlikely to be accepted. We recommend opening an issue and discussing it with us first.
- Ensure all code is type-safe and takes full advantage of TypeScript features.
- Write clear, self-explanatory code. Use comments only when truly necessary.
- Maintain compatibility with Better Auth's adapter interface.
- Follow the existing code style and conventions.
- We aim for stability, so avoid changes that would require users to run a migration or update their config.

## Getting Started

1. Fork the repository to your GitHub account
2. Clone your fork locally:
   ```bash
   git clone https://github.com/your-username/better-auth-firestore.git
   cd better-auth-firestore
   ```
3. Install Node.js (LTS version recommended, Node 22+ required)

   > **Note**: This project requires Node.js 22 or higher.

4. Install `pnpm` if you haven't already:

   > **Note:** This project is configured to manage [pnpm](https://pnpm.io/) via [corepack](https://github.com/nodejs/corepack). Once installed, upon usage you'll be prompted to install the correct pnpm version

   Alternatively, use `npm` to install it:

   ```bash
   npm install -g pnpm
   ```

5. Install project dependencies:
   ```bash
   pnpm install
   ```

6. Build the project:
   ```bash
   pnpm build
   ```

7. Run the test suite:
   ```bash
   pnpm test
   ```

## Code Formatting with BiomeJS

We use [BiomeJS](https://biomejs.dev/) for code formatting and linting. Before committing, please ensure your code is properly formatted:

```bash
# Format all code
pnpm lint:fix

# Check for linting issues
pnpm lint

# Fix auto-fixable issues (including unsafe fixes)
pnpm lint:fix:unsafe
```

## Development Workflow

1. Create a new branch for your changes:
   ```bash
   git checkout -b type/description
   # Example: git checkout -b feat/custom-collection-names
   ```
   
   Branch type prefixes:
   - `feat/` - New features
   - `fix/` - Bug fixes
   - `docs/` - Documentation changes
   - `refactor/` - Code refactoring
   - `test/` - Test-related changes
   - `chore/` - Build process or tooling changes

2. Make your changes following the code style guidelines
3. Add tests for your changes
4. Run the test suite:
   ```bash
   # Run all tests
   pnpm test
   ```

   > **Note:** For local testing, you may need to set up the Firestore Emulator. See the [README.md](./README.md#testing-with-firestore-emulator) for instructions.

5. Ensure all tests pass and the code is properly formatted
6. Commit your changes with a descriptive message following this format:
   
   For changes that need to be included in the changelog (excluding docs or chore changes), use the `fix` or `feat` format:
   ```
   fix: resolve memory leak in session handling
   
   feat: add support for custom collection names
   ```

   For documentation changes, use `docs`:
   ```bash
   docs: improve adapter setup explanation
   docs: fix typos in README
   ```
   
   For changes that refactor or don't change the functionality, use `chore`:
   ```bash
   chore: update dependencies to latest versions
   chore: refactor adapter initialization
   ```

   Each commit message should be clear and descriptive, explaining what the change does. For features and fixes, include context about what was added or resolved.

7. Push your branch to your fork
8. Open a pull request against the **main** branch. In your PR description:
   - Clearly describe what changes you made and why
   - Include any relevant context or background
   - List any breaking changes or deprecations
   - Add screenshots for UI changes (if applicable)
   - Reference related issues or discussions

## Testing

All contributions must include appropriate tests. Follow these guidelines:

- Write unit tests for new features
- Ensure all tests pass before submitting a pull request
- Update existing tests if your changes affect their behavior
- Follow the existing test patterns and structure
- Test with the Firestore Emulator for local development

### Running Tests

```bash
# Run all tests
pnpm test

# Run tests in watch mode (if supported)
pnpm test --watch
```

### Testing with Firestore Emulator

For local development, you can use the Firestore Emulator. See the [README.md](./README.md#testing-with-firestore-emulator) for setup instructions.

## Pull Request Process

1. Create a draft pull request early to facilitate discussion
2. Reference any related issues in your PR description (e.g., 'Closes #123')
3. Ensure all tests pass and the build is successful
4. Update documentation as needed
5. Keep your PR focused on a single feature or bug fix
6. Be responsive to code review feedback
7. The project uses semantic-release, so changelog updates are handled automatically based on commit messages

## Code Style

- Follow the existing code style
- Use TypeScript types and interfaces effectively
- Keep functions small and focused
- Use meaningful variable and function names
- Add comments for complex logic
- Update relevant documentation when making API changes
- Follow the BiomeJS formatting rules
- Avoid using Classes

## Adapter-Specific Guidelines

### Core Adapter (`/src`)

- Keep the adapter focused on Firestore-specific functionality
- Ensure all public APIs are well-documented with JSDoc comments
- Maintain compatibility with Better Auth's adapter interface
- Follow the existing patterns for error handling and logging
- Ensure compatibility with Firebase Admin SDK patterns

### Documentation (`/README.md`)

- Keep documentation up-to-date with code changes
- Use clear, concise language
- Include code examples for common use cases
- Document any breaking changes clearly
- Follow the existing documentation style and structure

### Examples (`/examples`)

- Keep examples simple and focused
- Ensure examples work with the latest version
- Update examples when making breaking changes
- Include comments explaining key concepts

## Security Issues

For security-related issues, please email the maintainer directly or open a private security advisory on GitHub. Include a detailed description of the vulnerability and steps to reproduce it. All reports will be reviewed and addressed promptly.

## Questions?

If you have questions about contributing, feel free to:
- Open an issue for discussion
- Check existing issues and pull requests
- Review the [Better Auth documentation](https://www.better-auth.com/docs)

Thank you for contributing to Better Auth Firestore! 🎉

