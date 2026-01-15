"""
State Transaction Layer for AIDM v3.

Implements atomic state transactions with Change Log format per Module 03 spec.
All state modifications must go through transactions to ensure:
- Before-value verification (detect desyncs)
- Constraint validation (resource bounds, etc.)
- Atomic commit (all succeed or rollback)
"""

from datetime import datetime
from enum import Enum
from typing import Any, Dict, List, Optional, Callable
from pydantic import BaseModel, Field


class ChangeOperation(Enum):
    """Types of state change operations."""
    SET = "set"           # Direct assignment
    ADD = "add"           # Numeric addition
    SUBTRACT = "subtract" # Numeric subtraction
    MULTIPLY = "multiply" # Numeric multiplication
    APPEND = "append"     # Array append
    REMOVE = "remove"     # Array remove
    REPLACE = "replace"   # Array/string replace


class StateChange(BaseModel):
    """A single state change entry in Change Log format."""
    path: str                           # "resources.mp.current"
    operation: ChangeOperation
    before: Any                         # Value before change
    after: Any                          # Value after change
    delta: Optional[Any] = None         # For numeric: the diff value
    reason: str                         # "Fire Bolt cast"
    validated: bool = False
    timestamp: datetime = Field(default_factory=datetime.now)
    
    class Config:
        use_enum_values = True


class ValidationError(BaseModel):
    """A validation error for a state change."""
    path: str
    error_type: str  # "desync", "type_mismatch", "range_violation", "constraint_violation"
    message: str
    expected: Optional[Any] = None
    actual: Optional[Any] = None


class ValidationResult(BaseModel):
    """Result of validating a transaction."""
    is_valid: bool
    errors: List[ValidationError] = []
    warnings: List[str] = []
    # For narrative override consideration - constraint violations that could be overridden
    override_candidates: List[ValidationError] = []


# Default constraints for common paths
DEFAULT_CONSTRAINTS: Dict[str, Dict[str, Any]] = {
    "resources.hp.current": {"min": 0, "max_ref": "resources.hp.max"},
    "resources.mp.current": {"min": 0, "max_ref": "resources.mp.max"},
    "resources.sp.current": {"min": 0, "max_ref": "resources.sp.max"},
}


class StateTransaction:
    """
    Atomic state transaction with Change Log format.
    
    Usage:
        with state_manager.begin_transaction("Cast Fire Bolt") as txn:
            txn.subtract("resources.mp.current", 50, reason="Spell cost")
            txn.subtract("target.resources.hp.current", 35, reason="Fire damage")
        # Automatically commits on exit, rolls back on exception
    """
    
    def __init__(
        self, 
        state_getter: Callable[[str], Any],
        state_setter: Callable[[str, Any], None],
        description: str = ""
    ):
        """
        Initialize a state transaction.
        
        Args:
            state_getter: Function to get current value at path
            state_setter: Function to set value at path
            description: Human-readable description of transaction
        """
        self.state_getter = state_getter
        self.state_setter = state_setter
        self.description = description
        self.changes: List[StateChange] = []
        self.committed = False
        self.rolled_back = False
        self._applied: List[StateChange] = []
        
    def __enter__(self):
        return self
        
    def __exit__(self, exc_type, exc_val, exc_tb):
        if exc_type is not None:
            # Exception occurred, rollback
            self.rollback()
            return False
        
        if not self.committed and not self.rolled_back:
            # Auto-commit on clean exit
            self.commit()
        return False
    
    # ==== Change Methods ====
    
    def set(self, path: str, value: Any, reason: str = "") -> "StateTransaction":
        """Set a value directly."""
        before = self.state_getter(path)
        self.changes.append(StateChange(
            path=path,
            operation=ChangeOperation.SET,
            before=before,
            after=value,
            delta=None,
            reason=reason
        ))
        return self
    
    def add(self, path: str, delta: float, reason: str = "") -> "StateTransaction":
        """Add to a numeric value."""
        before = self.state_getter(path) or 0
        after = before + delta
        self.changes.append(StateChange(
            path=path,
            operation=ChangeOperation.ADD,
            before=before,
            after=after,
            delta=delta,
            reason=reason
        ))
        return self
    
    def subtract(self, path: str, delta: float, reason: str = "") -> "StateTransaction":
        """Subtract from a numeric value."""
        before = self.state_getter(path) or 0
        after = before - delta
        self.changes.append(StateChange(
            path=path,
            operation=ChangeOperation.SUBTRACT,
            before=before,
            after=after,
            delta=-delta,
            reason=reason
        ))
        return self
    
    def multiply(self, path: str, factor: float, reason: str = "") -> "StateTransaction":
        """Multiply a numeric value."""
        before = self.state_getter(path) or 0
        after = before * factor
        self.changes.append(StateChange(
            path=path,
            operation=ChangeOperation.MULTIPLY,
            before=before,
            after=after,
            delta=factor,
            reason=reason
        ))
        return self
    
    def append(self, path: str, item: Any, reason: str = "") -> "StateTransaction":
        """Append to an array."""
        before = self.state_getter(path) or []
        after = before + [item]
        self.changes.append(StateChange(
            path=path,
            operation=ChangeOperation.APPEND,
            before=before,
            after=after,
            delta=item,
            reason=reason
        ))
        return self
    
    def remove(self, path: str, item: Any, reason: str = "") -> "StateTransaction":
        """Remove from an array."""
        before = self.state_getter(path) or []
        after = [x for x in before if x != item]
        self.changes.append(StateChange(
            path=path,
            operation=ChangeOperation.REMOVE,
            before=before,
            after=after,
            delta=item,
            reason=reason
        ))
        return self
    
    # ==== Validation ====
    
    def validate(self, constraints: Optional[Dict[str, Dict]] = None) -> ValidationResult:
        """
        Validate all changes in the transaction.
        
        Checks:
        1. Before-value verification (detect desyncs)
        2. Type checking
        3. Range checking (min/max constraints)
        4. Delta verification (math is correct)
        """
        if constraints is None:
            constraints = DEFAULT_CONSTRAINTS
            
        errors = []
        warnings = []
        
        for change in self.changes:
            # 1. Before-value verification
            current = self.state_getter(change.path)
            if current != change.before:
                errors.append(ValidationError(
                    path=change.path,
                    error_type="desync",
                    message=f"State desync: expected {change.before}, got {current}",
                    expected=change.before,
                    actual=current
                ))
                continue
            
            # 2. Delta verification for numeric operations
            if change.operation in [ChangeOperation.ADD, ChangeOperation.SUBTRACT]:
                if change.delta is not None:
                    expected_after = change.before + change.delta
                    if abs(expected_after - change.after) > 0.0001:  # Float tolerance
                        errors.append(ValidationError(
                            path=change.path,
                            error_type="calculation_error",
                            message=f"Delta mismatch: {change.before} + {change.delta} != {change.after}",
                            expected=expected_after,
                            actual=change.after
                        ))
                        continue
            
            # 3. Range checking
            if change.path in constraints:
                constraint = constraints[change.path]
                
                # Check minimum
                if "min" in constraint and change.after < constraint["min"]:
                    errors.append(ValidationError(
                        path=change.path,
                        error_type="range_violation",
                        message=f"Value {change.after} below minimum {constraint['min']}",
                        expected=f">= {constraint['min']}",
                        actual=change.after
                    ))
                    continue
                
                # Check maximum (may be reference to another path)
                if "max" in constraint and change.after > constraint["max"]:
                    errors.append(ValidationError(
                        path=change.path,
                        error_type="range_violation",
                        message=f"Value {change.after} above maximum {constraint['max']}",
                        expected=f"<= {constraint['max']}",
                        actual=change.after
                    ))
                    continue
                
                if "max_ref" in constraint:
                    max_val = self.state_getter(constraint["max_ref"])
                    if max_val is not None and change.after > max_val:
                        errors.append(ValidationError(
                            path=change.path,
                            error_type="range_violation",
                            message=f"Value {change.after} above maximum {max_val}",
                            expected=f"<= {max_val}",
                            actual=change.after
                        ))
                        continue
            
            # Mark as validated
            change.validated = True
        
        return ValidationResult(
            is_valid=len(errors) == 0,
            errors=errors,
            warnings=warnings
        )
    
    # ==== Commit / Rollback ====
    
    def commit(self, constraints: Optional[Dict[str, Dict]] = None) -> bool:
        """
        Validate and atomically apply all changes.
        
        Returns:
            True if committed successfully, False if validation failed
            
        Raises:
            RuntimeError: If transaction already committed or rolled back
        """
        if self.committed:
            raise RuntimeError("Transaction already committed")
        if self.rolled_back:
            raise RuntimeError("Transaction already rolled back")
        
        # Validate first
        validation = self.validate(constraints)
        if not validation.is_valid:
            error_msgs = [e.message for e in validation.errors]
            print(f"[Transaction] Validation failed: {error_msgs}")
            return False
        
        # Apply changes atomically
        try:
            for change in self.changes:
                self.state_setter(change.path, change.after)
                self._applied.append(change)
                print(f"[Transaction] {change.path}: {change.before} → {change.after} ({change.reason})")
            
            self.committed = True
            return True
            
        except Exception as e:
            # Rollback on any failure
            print(f"[Transaction] Error during commit: {e}, rolling back...")
            self.rollback()
            raise
    
    def rollback(self):
        """
        Revert all applied changes.
        
        Applies inverse operations to restore previous state.
        """
        if self.rolled_back:
            return
        
        # Rollback in reverse order
        for change in reversed(self._applied):
            try:
                self.state_setter(change.path, change.before)
                print(f"[Transaction] Rollback {change.path}: {change.after} → {change.before}")
            except Exception as e:
                print(f"[Transaction] Error during rollback: {e}")
        
        self._applied.clear()
        self.rolled_back = True
    
    # ==== Utility ====
    
    def get_change_log(self) -> List[Dict[str, Any]]:
        """Get the change log as a list of dicts."""
        return [change.model_dump() for change in self.changes]
    
    def __repr__(self) -> str:
        status = "committed" if self.committed else ("rolled_back" if self.rolled_back else "pending")
        return f"<StateTransaction '{self.description}' {len(self.changes)} changes, {status}>"


class TransactionManager:
    """
    Factory for creating transactions with state access.
    
    Wraps a state manager to provide get/set functions.
    """
    
    def __init__(self, state_manager):
        """
        Initialize with a StateManager instance.
        
        Args:
            state_manager: StateManager with get_value/set_value methods
        """
        self.state_manager = state_manager
        self._state_cache: Dict[str, Any] = {}
    
    def begin_transaction(self, description: str = "") -> StateTransaction:
        """
        Begin a new transaction.
        
        Args:
            description: Human-readable description of the transaction
            
        Returns:
            StateTransaction instance
        """
        return StateTransaction(
            state_getter=self._get_value,
            state_setter=self._set_value,
            description=description
        )
    
    def _get_value(self, path: str) -> Any:
        """Get a value from state by dot-notation path."""
        # Check cache first
        if path in self._state_cache:
            return self._state_cache[path]
        
        # Otherwise get from state manager
        value = self.state_manager.get_value(path)
        self._state_cache[path] = value
        return value
    
    def _set_value(self, path: str, value: Any):
        """Set a value in state by dot-notation path."""
        self.state_manager.set_value(path, value)
        self._state_cache[path] = value
